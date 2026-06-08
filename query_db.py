import sqlite3
import os
import sys

def get_vscdb_path():
    home = os.path.expanduser("~")
    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA", os.path.join(home, "AppData", "Roaming"))
        for name in ["Antigravity IDE", "Antigravity"]:
            db_path = os.path.join(appdata, name, "User", "globalStorage", "state.vscdb")
            if os.path.exists(db_path):
                return db_path
    elif sys.platform == "darwin":
        for name in ["Antigravity IDE", "Antigravity"]:
            db_path = os.path.join(home, "Library", "Application Support", name, "User", "globalStorage", "state.vscdb")
            if os.path.exists(db_path):
                return db_path
    else:  # linux
        config = os.environ.get("XDG_CONFIG_HOME", os.path.join(home, ".config"))
        for name in ["Antigravity IDE", "Antigravity"]:
            db_path = os.path.join(config, name, "User", "globalStorage", "state.vscdb")
            if os.path.exists(db_path):
                return db_path
    return None

db_path = get_vscdb_path()
if not db_path:
    print("Error: Could not locate state.vscdb directory.")
    sys.exit(1)

print(f"Reading from database: {db_path}")
try:
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute("SELECT key, value FROM ItemTable")
    rows = cursor.fetchall()
    
    found = False
    for key, value in rows:
        if key.startswith('antigravity') or key.startswith('google.antigravity'):
            print(f"Key: {key}")
            if 'token' in key.lower():
                masked_value = value[:15] + "..." + value[-15:] if len(value) > 30 else "[hidden]"
                print(f"Value (Masked for security): {masked_value}")
            else:
                print(f"Value: {value}")
            found = True
            
    if not found:
        print("No related keys found in state.vscdb")
        
except Exception as e:
    print(f"Error: {e}")

