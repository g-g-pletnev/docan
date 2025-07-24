import express from 'express';
import fs from 'fs';
import path from 'path';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';
import { getTextExtractor } from 'office-text-extractor';
import { execFile } from 'child_process';
import util from 'util';
import { WebSocketServer } from 'ws';

const execFileAsync = util.promisify(execFile);
const app = express();
const PORT = 3000;

const TYPES_FILE = 'types.json';
const UPLOAD_DIR = 'uploads';

// --- WebSocket ---
const wss = new WebSocketServer({ noServer: true });
let lastStepTime = Date.now();
function broadcastStatus(step, message) {
  const now = Date.now();
  const elapsed = ((now - lastStepTime) / 1000).toFixed(2);
  lastStepTime = now;

  console.log(`[WS] ${step}: ${message} (${elapsed}s)`);
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(JSON.stringify({ step, message, elapsed }));
    }
  });
}

// Создаём папку для загрузок
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

// Инициализация списка типов
if (!fs.existsSync(TYPES_FILE)) {
  const defaultTypes = [
    { name: "report", description: "Стандартный отчёт" },
    { name: "invoice", description: "Счёт на оплату" },
    { name: "presentation", description: "Презентация" }
  ];
  fs.writeFileSync(TYPES_FILE, JSON.stringify(defaultTypes, null, 2));
}

app.use(bodyParser.json());
app.use(express.static('public'));

// --- OCR через Tesseract ---
async function extractWithTesseract(inputPath) {
  try {
    const tempDir = path.join(UPLOAD_DIR, `tess_${Date.now()}`);
    fs.mkdirSync(tempDir);

    const ext = path.extname(inputPath).toLowerCase();
    let images = [];

    if (ext === '.pdf') {
      broadcastStatus('ocr', 'Конвертация PDF в изображения...');
      await execFileAsync('pdftoppm', ['-png', inputPath, path.join(tempDir, 'page')]);
      images = fs.readdirSync(tempDir).filter(f => f.endsWith('.png')).sort();
    } else {
      const baseName = path.basename(inputPath);
      const targetPath = path.join(tempDir, baseName);
      fs.copyFileSync(inputPath, targetPath);
      images = [baseName];
    }

    let fullText = '';
    for (const img of images) {
      const imgPath = path.join(tempDir, img);
      broadcastStatus('ocr', `Tesseract OCR для ${img}...`);
      const txtPath = imgPath.replace('.png', '');
      await execFileAsync(
        'tesseract',
        [imgPath, txtPath, '-l', 'eng+rus'],
        { env: { ...process.env, LANG: 'ru_RU.UTF-8' } }
      );
      const ocrText = fs.readFileSync(`${txtPath}.txt`, 'utf8');
      fullText += ocrText + '\n';
    }

    broadcastStatus('ocr', 'Tesseract OCR завершил извлечение текста.');
    return fullText;
  } catch (err) {
    console.error('Tesseract OCR error:', err);
    broadcastStatus('error', 'Ошибка при работе Tesseract OCR.');
    return '';
  }
}

// --- Универсальный экстрактор текста ---
const docExtractor = getTextExtractor();
async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const fileName = path.basename(filePath);

  if (ext === '.pdf' || ['.png', '.jpg', '.jpeg', '.bmp'].includes(ext)) {
    broadcastStatus('ocr', `Используется Tesseract для: ${fileName}`);
    return await extractWithTesseract(filePath);
  }

  broadcastStatus('extract', `Извлечение текста через office-text-extractor (${ext})...`);
  const text = await docExtractor.extractText({ input: filePath, type: 'file' });
  broadcastStatus('extract', 'Текст извлечён.');
  return text;
}

// --- Получение моделей ---
app.get('/models', async (req, res) => {
  try {
    const data = await fetch('http://localhost:11434/api/tags').then(r => r.json());
    res.json({ models: data.models?.map(m => m.name) || [] });
  } catch (e) {
    res.status(500).json({ error: 'Не удалось получить список моделей из Ollama' });
  }
});

// --- Запрос к Ollama ---
async function askOllamaStructured(prompt, schema, model) {
  broadcastStatus('llm', `Анализ текста моделью ${model}...`);
  const response = await fetch('http://localhost:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      format: schema,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  const data = await response.json();
  broadcastStatus('llm', 'Анализ завершён.');
  return data.message ? JSON.parse(data.message.content) : data;
}

// --- Загрузка файла ---
app.post('/upload', (req, res) => {
  try {
    const modelName = req.query.model || 'gemma3n:e4b-it-fp16';
    broadcastStatus('upload', 'Загрузка файла...');

    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(.+)$/);
    if (!boundaryMatch) {
      return res.status(400).json({ error: 'Некорректный заголовок Content-Type' });
    }
    const boundary = `--${boundaryMatch[1]}`;

    let rawData = Buffer.alloc(0);
    req.on('data', chunk => {
      rawData = Buffer.concat([rawData, chunk]);
    });

    req.on('end', async () => {
      try {
        const parts = rawData.toString('binary').split(boundary);
        const filePart = parts.find(p => p.includes('filename='));
        if (!filePart) {
          return res.status(400).json({ error: 'Файл не найден в запросе' });
        }

        const match = filePart.match(/filename="(.+?)"/);
        const originalName = match ? match[1] : `upload_${Date.now()}.bin`;
        const ext = path.extname(originalName) || '.pdf';
        const fileName = `upload_${Date.now()}${ext}`;
        const filePath = path.join(UPLOAD_DIR, fileName);

        const fileContentIndex = filePart.indexOf('\r\n\r\n');
        const fileContent = filePart
          .slice(fileContentIndex + 4)
          .split('\r\n')
          .slice(0, -1)
          .join('\r\n');
        const fileBuffer = Buffer.from(fileContent, 'binary');

        fs.writeFileSync(filePath, fileBuffer);
        broadcastStatus('upload', `Файл сохранён как ${fileName}`);

        broadcastStatus('process', 'Начало обработки файла...');
        let textSnippet = await extractText(filePath);
        textSnippet = textSnippet.slice(0, 3000);

        const typesList = JSON.parse(fs.readFileSync(TYPES_FILE));
        const typesForPrompt = typesList.map(t => `${t.name} — ${t.description}`).join('\n');

        const schema = {
          type: "object",
          properties: {
            type: { type: "string", minLength: 1 },
            summary: { type: "string", minLength: 10 }
          },
          required: ["type", "summary"]
        };

        const prompt = `
Есть список известных типов документов:
${typesForPrompt}

Выбери подходящий (одно слово). Если не подходит — предложи новый.
Сделай краткое саммари (1 абзац).

Текст документа:
${textSnippet}
        `;

        const llmResult = await askOllamaStructured(prompt, schema, modelName);
        const found = typesList.find(
          t => t.name.toLowerCase() === llmResult.type.toLowerCase()
        );

        broadcastStatus('done', 'Обработка завершена.');
        res.json({
          type: llmResult.type.toLowerCase(),
          summary: llmResult.summary,
          description: found ? found.description : null,
          isNewType: !found
        });
      } catch (err) {
        console.error('Ошибка при обработке файла:', err);
        broadcastStatus('error', 'Ошибка при обработке файла');
        res.status(500).json({ error: 'Ошибка обработки файла' });
      }
    });
  } catch (e) {
    console.error(e);
    broadcastStatus('error', 'Ошибка загрузки файла.');
    res.status(500).json({ error: 'Ошибка загрузки файла' });
  }
});

// --- Добавление нового типа ---
app.post('/confirm-type', (req, res) => {
  const { type, description } = req.body;
  let types = JSON.parse(fs.readFileSync(TYPES_FILE));
  if (!types.find(t => t.name === type)) {
    types.push({ name: type, description: description || "" });
    fs.writeFileSync(TYPES_FILE, JSON.stringify(types, null, 2));
  }
  res.json({ success: true, types });
});

// --- Запуск сервера и WS ---
const server = app.listen(PORT, () => {
  console.log(`Сервер запущен: http://localhost:${PORT}`);
});
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ocr-progress') {
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit('connection', ws, req);
    });
  }
});
