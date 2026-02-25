import whisper
import sys
import json
import warnings
import traceback
import torch
from pydub import AudioSegment
import os
import hashlib

# Suppress warnings
warnings.filterwarnings("ignore")

def get_file_hash(file_path):
    """Generate unique hash for file to identify checkpoints"""
    with open(file_path, 'rb') as f:
        return hashlib.md5(f.read()).hexdigest()[:16]

def save_checkpoint(checkpoint_path, chunk_index, all_text, total_chunks):
    """Save progress checkpoint"""
    try:
        checkpoint_data = {
            "chunk_index": chunk_index,
            "segments": all_text,
            "total_chunks": total_chunks
        }
        with open(checkpoint_path, 'w', encoding='utf-8') as f:
            json.dump(checkpoint_data, f, ensure_ascii=False)
    except Exception as e:
        print(json.dumps({"type": "warning", "message": f"Checkpoint save failed: {str(e)}"}), flush=True)

def load_checkpoint(checkpoint_path):
    """Load existing checkpoint if available"""
    try:
        if os.path.exists(checkpoint_path):
            with open(checkpoint_path, 'r', encoding='utf-8') as f:
                return json.load(f)
    except Exception as e:
        print(json.dumps({"type": "warning", "message": f"Checkpoint load failed: {str(e)}"}), flush=True)
    return None

def transcribe_with_progress(file_path, model_name="base", chunk_duration=30000):
    """
    Transcribe audio file in chunks and output progress
    chunk_duration in milliseconds (default 30 seconds)
    """
    try:
        # Setup checkpoint system
        checkpoint_dir = os.path.join(os.path.dirname(file_path), '..', 'checkpoints')
        os.makedirs(checkpoint_dir, exist_ok=True)
        
        file_hash = get_file_hash(file_path)
        checkpoint_path = os.path.join(checkpoint_dir, f"{file_hash}_{model_name}.json")
        
        # Check for existing checkpoint
        checkpoint = load_checkpoint(checkpoint_path)
        start_chunk = 0
        all_text = []
        
        if checkpoint:
            start_chunk = checkpoint["chunk_index"] + 1
            all_text = checkpoint["segments"]
            print(json.dumps({"type": "status", "message": f"Resuming from chunk {start_chunk}..."}), flush=True)
        
        # Check for GPU
        device = "cuda" if torch.cuda.is_available() else "cpu"
        print(json.dumps({"type": "status", "message": f"Using device: {device}"}), flush=True)
        if device == "cuda":
            print(json.dumps({"type": "status", "message": f"GPU: {torch.cuda.get_device_name(0)}"}), flush=True)
        
        # Load model with size indicator
        model_sizes = {"tiny": "39MB", "base": "74MB", "small": "244MB", "medium": "769MB", "large": "1550MB"}
        size_info = model_sizes.get(model_name, "unknown size")
        print(json.dumps({"type": "status", "message": f"Loading Whisper {model_name} model ({size_info})..."}), flush=True)
        print(json.dumps({"type": "status", "message": "This may take 1-10 minutes depending on model size..."}), flush=True)
        
        model = whisper.load_model(model_name, device=device)
        print(json.dumps({"type": "status", "message": f"Model {model_name} loaded successfully!"}), flush=True)
        
        # Load audio file
        print(json.dumps({"type": "status", "message": "Loading audio file..."}), flush=True)
        audio = AudioSegment.from_file(file_path)
        total_duration = len(audio)
        
        # Calculate number of chunks
        num_chunks = (total_duration + chunk_duration - 1) // chunk_duration
        print(json.dumps({"type": "info", "total_chunks": num_chunks, "total_duration": total_duration / 1000}), flush=True)
        print(json.dumps({"type": "status", "message": f"Audio: {total_duration/1000:.1f} seconds, will process in {num_chunks} chunks"}), flush=True)
        
        # Process each chunk
        for i in range(start_chunk, num_chunks):
            start = i * chunk_duration
            end = min((i + 1) * chunk_duration, total_duration)
            
            # Extract chunk
            chunk = audio[start:end]
            chunk_path = f"{file_path}_chunk_{i}.wav"
            chunk.export(chunk_path, format="wav")
            
            try:
                # Transcribe chunk
                print(json.dumps({
                    "type": "progress",
                    "chunk": i + 1,
                    "total_chunks": num_chunks,
                    "percent": int((i + 1) / num_chunks * 100)
                }), flush=True)
                
                result = model.transcribe(
                    chunk_path,
                    language="he",
                    verbose=False,
                    fp16=(device == "cuda")
                )
                
                chunk_text = result["text"].strip()
                if chunk_text:
                    all_text.append(chunk_text)
                    
                    # Send chunk result
                    print(json.dumps({
                        "type": "segment",
                        "chunk": i + 1,
                        "text": chunk_text,
                        "start_time": start / 1000,
                        "end_time": end / 1000
                    }), flush=True)
                
                # Clean up chunk file
                os.remove(chunk_path)
                
                # Save checkpoint after each successful chunk
                save_checkpoint(checkpoint_path, i, all_text, num_chunks)
                
            except Exception as e:
                print(json.dumps({"type": "error", "message": f"Error in chunk {i + 1}: {str(e)}"}), flush=True)
                if os.path.exists(chunk_path):
                    os.remove(chunk_path)
                # Save checkpoint even on error so we can resume
                save_checkpoint(checkpoint_path, i, all_text, num_chunks)
                continue
        
        # Final output
        final_text = " ".join(all_text)
        print(json.dumps({
            "type": "complete",
            "text": final_text,
            "language": "he"
        }), flush=True)
        
        # Clean up checkpoint on successful completion
        if os.path.exists(checkpoint_path):
            os.remove(checkpoint_path)
        
    except Exception as e:
        print(json.dumps({
            "type": "error",
            "error": str(e),
            "traceback": traceback.format_exc()
        }), flush=True)
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"type": "error", "error": "No file path provided"}), flush=True)
        sys.exit(1)
    
    file_path = sys.argv[1]
    model_name = sys.argv[2] if len(sys.argv) > 2 else "base"
    
    transcribe_with_progress(file_path, model_name)
