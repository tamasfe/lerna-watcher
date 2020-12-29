#!/usr/bin/env node
var fs = require('fs');
var path = "dist/index.js";
var data = "#!/usr/bin/env node\n\n";
data += fs.readFileSync(path);
fs.writeFileSync(path, data);