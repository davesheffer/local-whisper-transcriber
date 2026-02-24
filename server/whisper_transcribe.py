import whisper
import sys
import json
import warnings
import traceback
import torch

# Suppress warnings
warnings.filterwarnings("ignore")

def progress_callback(progress):
    """Callback for progress updates"""
    print(f"PROGRESS:{progress}", file=sys.stderr, flush=True)

def transcribe_audio(file_path, model_name="base"):
    """
    Transcribe audio file using Whisper with GPU acceleration
    """
    try:
        # Check for GPU
        device = "cuda" if torch.cuda.is_available() else "cpu"
        print(f"Using device: {device}", file=sys.stderr, flush=True)
        if device == "cuda":
            print(f"GPU: {torch.cuda.get_device_name(0)}", file=sys.stderr, flush=True)
        
        # Load model
        print(f"Loading Whisper model: {model_name}...", file=sys.stderr, flush=True)
        model = whisper.load_model(model_name, device=device)
        
        # Transcribe with progress
        print(f"Transcribing audio...", file=sys.stderr, flush=True)
        
        # Custom progress tracking
        result = model.transcribe(
            file_path,
            language="he",  # Hebrew optimization
            verbose=False,
            fp16=(device == "cuda")  # Use FP16 on GPU for speed
        )
        
        # Return JSON result
        output = {
            "text": result["text"],
            "language": result.get("language", "unknown"),
            "segments": result.get("segments", [])
        }
        
        print(json.dumps(output))
        
    except Exception as e:
        print(f"Error details: {traceback.format_exc()}", file=sys.stderr)
        error_output = {
            "error": str(e),
            "type": type(e).__name__,
            "text": ""
        }
        print(json.dumps(error_output))
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No file path provided"}))
        sys.exit(1)
    
    file_path = sys.argv[1]
    model_name = sys.argv[2] if len(sys.argv) > 2 else "base"
    
    transcribe_audio(file_path, model_name)
