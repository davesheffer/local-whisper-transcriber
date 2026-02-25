const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "http://localhost:3000",
    methods: ["GET", "POST"]
  }
});
const PORT = 5000;

// Track active transcription processes
const activeProcesses = new Map(); // socketId -> { pythonProcess, filePath }

// Configure multer for file uploads
const upload = multer({ 
  dest: 'uploads/',
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB limit
});

app.use(cors());
app.use(express.json());

// WebSocket connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  socket.on('cancel-transcription', () => {
    console.log(`Cancel request from: ${socket.id}`);
    const processInfo = activeProcesses.get(socket.id);
    
    if (processInfo) {
      const { pythonProcess, filePath } = processInfo;
      
      // Kill Python process
      if (pythonProcess && !pythonProcess.killed) {
        pythonProcess.kill('SIGTERM');
        console.log(`Killed Python process for socket: ${socket.id}`);
      }
      
      // Clean up file
      if (filePath && fs.existsSync(filePath)) {
        fs.unlink(filePath, (err) => {
          if (err) console.error('Error deleting file:', err);
        });
      }
      
      // Remove from active processes
      activeProcesses.delete(socket.id);
      
      // Notify client
      socket.emit('transcription-cancelled', {
        message: 'Transcription cancelled successfully'
      });
    }
  });
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    
    // Clean up any active processes for this socket
    const processInfo = activeProcesses.get(socket.id);
    if (processInfo) {
      const { pythonProcess, filePath } = processInfo;
      
      if (pythonProcess && !pythonProcess.killed) {
        pythonProcess.kill('SIGTERM');
      }
      
      if (filePath && fs.existsSync(filePath)) {
        fs.unlink(filePath, (err) => {
          if (err) console.error('Error deleting file:', err);
        });
      }
      
      activeProcesses.delete(socket.id);
    }
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Audio Transcription Server</title>
        <style>
          body { font-family: Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; }
          h1 { color: #667eea; }
          .endpoint { background: #f5f5f5; padding: 15px; margin: 10px 0; border-radius: 5px; }
          .method { display: inline-block; padding: 5px 10px; border-radius: 3px; font-weight: bold; }
          .get { background: #61affe; color: white; }
          .post { background: #49cc90; color: white; }
          code { background: #e8e8e8; padding: 2px 6px; border-radius: 3px; }
        </style>
      </head>
      <body>
        <h1>🎵 Audio Transcription Server</h1>
        <p>Local Whisper API - Running on port ${PORT}</p>
        
        <h2>Available Endpoints:</h2>
        
        <div class="endpoint">
          <span class="method get">GET</span>
          <strong>/api/health</strong>
          <p>Check if the server is running</p>
        </div>
        
        <div class="endpoint">
          <span class="method post">POST</span>
          <strong>/api/transcribe</strong>
          <p>Transcribe an audio file</p>
          <p><strong>Body:</strong> Form data with <code>file</code> (audio file) and optional <code>model</code> (tiny, base, small, medium, large)</p>
        </div>
        
        <h3>Status: ✅ Server is running</h3>
        <p>Frontend should be running on: <a href="http://localhost:3000">http://localhost:3000</a></p>
      </body>
    </html>
  `);
});

// Transcription endpoint with streaming
app.post('/api/transcribe', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const filePath = req.file.path;
  const model = req.body.model || 'base';
  const socketId = req.body.socketId;

  console.log(`Transcribing file: ${req.file.originalname} with model: ${model}`);

  try {
    // Call Python streaming script
    const python = spawn('python', [
      path.join(__dirname, 'whisper_stream.py'),
      filePath,
      model
    ]);

    // Track this process
    if (socketId) {
      activeProcesses.set(socketId, { pythonProcess: python, filePath });
    }

    let hasError = false;
    let errorOutput = '';

    python.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').filter(line => line.trim());
      
      lines.forEach(line => {
        try {
          const jsonData = JSON.parse(line);
          
          // Emit to specific client via socket
          if (socketId) {
            io.to(socketId).emit('transcription-update', jsonData);
          }
          
          console.log(`[Stream] ${jsonData.type}:`, jsonData.message || jsonData.text?.substring(0, 50) || '');
          
          // If complete, send final response
          if (jsonData.type === 'complete') {
            res.json({
              text: jsonData.text,
              language: jsonData.language
            });
          }
        } catch (e) {
          console.error('Error parsing JSON:', line);
        }
      });
    });

    python.stderr.on('data', (data) => {
      errorOutput += data.toString();
      console.error(`Python stderr: ${data}`);
    });

    python.on('close', (code) => {
      // Remove from active processes
      if (socketId) {
        activeProcesses.delete(socketId);
      }
      
      // Clean up uploaded file
      fs.unlink(filePath, (err) => {
        if (err) console.error('Error deleting file:', err);
      });

      if (code !== 0 && !res.headersSent) {
        // Check if it was cancelled (SIGTERM sends code 1 or null)
        if (code === null || code === 1) {
          console.log(`Process cancelled for socket: ${socketId}`);
          return;
        }
        
        console.error(`Python process exited with code ${code}`);
        return res.status(500).json({ 
          error: 'Transcription failed', 
          details: errorOutput 
        });
      }
    });

  } catch (error) {
    console.error('Transcription error:', error);
    
    // Clean up file on error
    fs.unlink(filePath, (err) => {
      if (err) console.error('Error deleting file:', err);
    });
    
    if (!res.headersSent) {
      res.status(500).json({ 
        error: 'Transcription failed', 
        message: error.message 
      });
    }
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Transcription server is running' 
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Transcription server running on http://localhost:${PORT}`);
  console.log(`📝 Upload endpoint: http://localhost:${PORT}/api/transcribe`);
  console.log(`❤️  Health check: http://localhost:${PORT}/api/health`);
  console.log(`🔌 WebSocket ready for real-time streaming`);
  
  // Increase server timeouts for long-running transcriptions (2 hours)
  server.timeout = 7200000; // 2 hours
  server.keepAliveTimeout = 7200000;
  server.headersTimeout = 7210000;
  
  console.log(`⏱️  Server timeout: 2 hours (for long audio files)`);
});
