from os import system
import json
import glob
import os
import sys

# Find the most recent cpuprofile in Temp
temp_dir = os.environ.get("TEMP", "/tmp")
profiles = glob.glob(os.path.join(temp_dir, "exthost-*.cpuprofile"))
if not profiles:
    print("No profiles found")
    sys.exit(0)

newest_profile = max(profiles, key=os.path.getmtime)
print(f"Analyzing profile: {newest_profile}")

data = json.load(open(newest_profile, "r", encoding="utf-8"))
nodes = {n["id"]: n for n in data["nodes"]}

# Compute selfTime for each node
# samples and timeDeltas
samples = data.get("samples", [])
time_deltas = data.get("timeDeltas", [])

node_times = {}
for sample_id, delta in zip(samples, time_deltas):
    node_times[sample_id] = node_times.get(sample_id, 0) + delta

sorted_nodes = sorted(node_times.items(), key=lambda x: x[1], reverse=True)
print("\nTop functions by self-time:")
for node_id, self_time in sorted_nodes[:20]:
    node = nodes[node_id]
    frame = node["callFrame"]
    func = frame.get("functionName", "(anonymous)")
    url = frame.get("url", "")
    line = frame.get("lineNumber", -1)
    print(f"Time: {self_time/1000:.2f}ms | Func: {func} | File: {os.path.basename(url)}:{line}")
