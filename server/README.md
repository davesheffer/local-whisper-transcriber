# Local Whisper Server Setup

## Quick Start

1. **Install Python dependencies:**
   ```bash
   pip install -r requirements.txt
   ```

2. **Install Node.js dependencies:**
   ```bash
   npm install
   ```

3. **Start the server:**
   ```bash
   npm start
   ```

Server runs on `http://localhost:5000`

## API Endpoints

### Health Check
```
GET /api/health
```

### Transcribe Audio
```
POST /api/transcribe
Content-Type: multipart/form-data

Body:
- file: audio file (M4A, MP3, WAV, etc.)
- model: whisper model (tiny, base, small, medium, large)
```

## Python Requirements

- Python 3.8+
- openai-whisper
- ffmpeg (installed automatically with whisper)

## Model Sizes

| Model  | Parameters | VRAM | Speed     |
|--------|-----------|------|-----------|
| tiny   | 39M       | ~1GB | ~32x      |
| base   | 74M       | ~1GB | ~16x      |
| small  | 244M      | ~2GB | ~6x       |
| medium | 769M      | ~5GB | ~2x       |
| large  | 1550M     | ~10GB| 1x        |

## GPU Acceleration

If you have CUDA-enabled GPU:
```bash
pip install openai-whisper torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu118
```

## Troubleshooting

**Port already in use:**
Change PORT in server.js

**Python not found:**
- Windows: Add Python to PATH
- Use `python3` instead of `python`

**FFMPEG not found:**
```bash
# Windows (with Chocolatey)
choco install ffmpeg

# Or download from ffmpeg.org
```
