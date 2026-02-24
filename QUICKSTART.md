# 🚀 Quick Start Guide

## Windows Users (Easiest!)

### Option 1: Automated Setup
1. Double-click `setup.bat` to install everything
2. Double-click `start-all.bat` to run both servers
3. Open browser to `http://localhost:3000`

### Option 2: Manual Setup

**Step 1: Install Python dependencies**
```bash
cd server
pip install -r requirements.txt
```

**Step 2: Install Node.js dependencies**
```bash
# In server folder
npm install

# In root folder
cd ..
npm install
```

**Step 3: Start servers**

Terminal 1 (Backend):
```bash
cd server
npm start
```

Terminal 2 (Frontend):
```bash
npm start
```

## First Time Setup

### Prerequisites Check

1. **Python installed?**
   ```bash
   python --version
   # Should show Python 3.8 or higher
   ```

2. **Node.js installed?**
   ```bash
   node --version
   # Should show v14 or higher
   ```

3. **pip installed?**
   ```bash
   pip --version
   ```

### Installing Prerequisites

**Python:**
- Download from [python.org](https://www.python.org/downloads/)
- Check "Add Python to PATH" during installation

**Node.js:**
- Download from [nodejs.org](https://nodejs.org/)

## Testing the Setup

1. **Test backend:**
   ```bash
   cd server
   npm start
   ```
   Should see: `🚀 Transcription server running on http://localhost:5000`

2. **Test frontend:**
   ```bash
   npm start
   ```
   Browser should open to `http://localhost:3000`

## Common Issues

### "Python not found"
- Reinstall Python with "Add to PATH" checked
- Or use full path: `C:\Python3x\python.exe`

### "pip not found"
```bash
python -m ensurepip --upgrade
```

### "Port 5000 already in use"
Edit `server/server.js` and change `PORT = 5000` to another port (e.g., 5001)

### "Cannot find module 'express'"
```bash
cd server
npm install
```

### First transcription takes forever
- Whisper is downloading the model (~140MB)
- Only happens once, subsequent runs are fast

## Model Selection

In `server/server.js`, change line 18:
```javascript
const model = req.body.model || 'base'; // Change 'base' to your preference
```

Or in `src/App.js`, line 68:
```javascript
formData.append('model', 'base'); // Change 'base' to your preference
```

Options: `tiny`, `base`, `small`, `medium`, `large`

## Tips

- **First run**: Expect 1-2 minute download for the model
- **GPU users**: See server/README.md for GPU setup (10x faster!)
- **Large files**: May take several minutes depending on your CPU
- **Best quality**: Use `large` model (requires ~10GB RAM)

## Need Help?

Check the full README.md for detailed documentation!
