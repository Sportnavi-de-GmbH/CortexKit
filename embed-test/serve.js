// Tiny dependency-free static server for the embed test pages.
//   node embed-test/serve.js          → http://localhost:8080/simple.html
//   node embed-test/serve.js 3000     → any port; 8080 and 3001 are the ones PRODUCTION allows as embedders
const http = require("http"), fs = require("fs"), path = require("path");
const root = __dirname, port = Number(process.argv[2] || 8080);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p === "/") p = "/simple.html";
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, { "content-type": types[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
}).listen(port, () => console.log(`embed test pages → http://localhost:${port}/simple.html   (Ctrl-C to stop)`));
