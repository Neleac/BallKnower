var http = require("http");
var fs = require("fs");
var path = require("path");

var PORT = process.env.PORT || 3000;
var ROOT = __dirname;

var mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
};

function send(res, status, body, contentType) {
  res.writeHead(status, {
    "Content-Type": contentType || "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

var server = http.createServer(function(req, res) {
  var requestPath = req.url.split("?")[0];
  var filePath = requestPath === "/" ? "/index.html" : requestPath;
  var target = path.resolve(ROOT, "." + filePath);

  if (!target.startsWith(ROOT)) {
    send(res, 403, "Forbidden");
    return;
  }

  fs.readFile(target, function(err, content) {
    if (err) {
      send(res, 404, "Not found");
      return;
    }

    var contentType = mimeTypes[path.extname(target)] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": content.length,
      "Cache-Control": "no-store",
    });
    res.end(content);
  });
});

server.listen(PORT, function() {
  console.log("BallKnower serving on http://localhost:" + PORT);
});
