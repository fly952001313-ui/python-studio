let py,
  root,
  runId,
  count = 0,
  inputReady = false;
const sources = [
  new URL("./vendor/pyodide/", self.location.href).href,
  "https://cdn.jsdelivr.net/pyodide/v0.27.7/full/",
  "https://unpkg.com/pyodide@0.27.7/",
];
let budget = 100000,
  buffered = "",
  bucket = 0,
  messages = 0,
  truncated = false;
function flushOutput() {
  if (buffered) {
    postMessage({ type: "out", text: buffered });
    buffered = "";
    messages++;
  }
}
const send = (type, data = {}) => {
  if (type === "out") {
    if (budget <= 0) {
      if (!truncated) {
        buffered += "\n[Output limit reached / 已达到输出上限]\n";
        truncated = true;
        flushOutput();
      }
      return;
    }
    const text = data.text.slice(0, budget);
    budget -= text.length;
    buffered += text;
    const now = Math.floor(performance.now() / 1000);
    if (now !== bucket) {
      bucket = now;
      messages = 0;
    }
    if (messages < 200 || buffered.length >= 2048) flushOutput();
  } else {
    flushOutput();
    postMessage({ type, ...data });
  }
};
async function init() {
  let errors = [];
  for (const source of sources) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        send("status", {
          value: `Loading · ${source.includes("vendor/") ? "local runtime" : source.includes("jsdelivr") ? "jsDelivr" : "unpkg"} · ${attempt + 1}/2`,
        });
        importScripts(source + "pyodide.js");
        let attemptTimer;
        try {
          py = await Promise.race([
            loadPyodide({
              indexURL: source,
              stdout: (s) => send("out", { text: s + "\n" }),
              stderr: (s) => send("out", { text: s + "\n" }),
            }),
            new Promise((_, reject) => {
              attemptTimer = setTimeout(
                () => reject(Error("Runtime assets timed out at " + source)),
                15000,
              );
            }),
          ]);
        } finally {
          clearTimeout(attemptTimer);
        }
        send("ready", {
          version: py.runPython("import sys; sys.version.split()[0]"),
        });
        return;
      } catch (e) {
        errors.push(String(e));
      }
    }
  }
  send("fatal", {
    text:
      "Python download failed. Check network and press Restart.\n" +
      errors.join("\n"),
  });
}
onmessage = async ({ data: d }) => {
  if (d.type === "init") {
    root = d.root;
    await init();
  }
  if (d.type === "run") {
    runId = d.id;
    budget = 100000;
    buffered = "";
    messages = 0;
    truncated = false;
    inputReady = d.inputReady;
    try {
      const decoderOut = new TextDecoder(),
        decoderErr = new TextDecoder();
      const write = (decoder) => (bytes) => {
        send("out", { text: decoder.decode(bytes, { stream: true }) });
        return bytes.length;
      };
      py.setStdout({ write: write(decoderOut), isatty: false });
      py.setStderr({ write: write(decoderErr), isatty: false });
      try {
        py.FS.unmount("/work");
      } catch {}
      try {
        py.FS.mkdir("/work");
      } catch {}
      py.FS.mount(py.FS.filesystems.MEMFS, {}, "/work");
      for (const f of d.files) {
        const p = "/work/" + f.path;
        py.FS.mkdirTree(
          f.kind === "folder" ? p : p.slice(0, p.lastIndexOf("/")),
        );
        if (f.kind !== "folder") py.FS.writeFile(p, f.content);
      }
      py.registerJsModule("studio_bridge", {
        read: (prompt) => {
          if (!inputReady) return null;
          const id = runId + "-" + ++count;
          send("input", { id, prompt: String(prompt) });
          const xhr = new XMLHttpRequest();
          xhr.open(
            "GET",
            root + "__input__?id=" + encodeURIComponent(id),
            false,
          );
          xhr.send();
          if (xhr.status !== 200) throw Error("Input channel unavailable");
          const result = JSON.parse(xhr.responseText);
          if (result.eof) return null;
          return result.value;
        },
      });
      py.globals.set("_studio_path", d.path);
      await py.runPythonAsync(`
import sys, os, builtins, traceback, json, importlib, linecache
sys.stdout = sys.__stdout__
sys.stderr = sys.__stderr__
linecache.clearcache()
os.chdir('/work')
sys.path[:] = [p for p in sys.path if not p.startswith('/work')]
sys.path[:0] = [os.path.dirname('/work/' + _studio_path), '/work']
for _name, _module in list(sys.modules.items()):
    if str(getattr(_module, '__file__', '')).startswith('/work/') or any(str(p).startswith('/work/') for p in getattr(_module, '__path__', [])):
        del sys.modules[_name]
importlib.invalidate_caches()
from studio_bridge import read
def _studio_input(prompt=''):
    value = read(str(prompt))
    if value is None:
        raise EOFError('Interactive input requires an active Service Worker on HTTPS/localhost; enable site storage and reload.')
    return value
builtins.input = _studio_input
try:
    with open('/work/' + _studio_path, encoding='utf-8') as _file:
        _code = _file.read()
    exec(compile(_code, '/work/' + _studio_path, 'exec'), {'__name__':'__main__', '__file__':'/work/' + _studio_path})
except BaseException as _err:
    _frames = traceback.extract_tb(_err.__traceback__)
    _local = [f for f in _frames if f.filename.startswith('/work/')]
    _line = getattr(_err, 'lineno', None) or (_local[-1].lineno if _local else 1)
    _path = (getattr(_err, 'filename', None) if isinstance(_err, SyntaxError) else None) or (_local[-1].filename if _local else '/work/' + _studio_path)
    _result = json.dumps({'type':type(_err).__name__, 'message':str(_err), 'line':_line, 'path':_path.removeprefix('/work/'), 'traceback':traceback.format_exc()})
else:
    _result = ''
`);
      let error = py.globals.get("_result");
      send(error ? "error" : "done", error ? { error: JSON.parse(error) } : {});
    } catch (e) {
      send("fatal", { text: String(e) });
    }
  }
};
