import * as fs from "fs";
import * as path from "path";

const schemaPath = path.join(__dirname, "../prisma/schema.prisma");
const content = fs.readFileSync(schemaPath, "utf-8");

let newContent = content;

newContent = newContent.replace(
  /datasource db \{[\s\S]*?\}/,
  `datasource db {
  provider = "sqlite"
  url      = "file:./dev.db"
}`
);

newContent = newContent.replace(/@db\.VarChar\(\d+\)/g, "");

newContent = newContent.replace(
  /quoteTypes     String\[\]/,
  "quoteTypes     Json"
);

fs.writeFileSync(schemaPath, newContent);
console.log("Schema converted to SQLite format");
