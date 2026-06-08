import base64
import sys

if len(sys.argv) > 1:
    inner = sys.argv[1]
else:
    inner = input("Enter base64-encoded token to decode: ")

try:
    # Remove whitespace if present
    inner = inner.strip()
    decoded = base64.b64decode(inner)
    print("Decoded bytes:", decoded)
except Exception as e:
    print("Error decoding base64:", e)
