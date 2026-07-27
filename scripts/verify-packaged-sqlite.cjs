const { dirname, join } = require("node:path");

const packagedModule = join(
  dirname(process.execPath),
  "resources",
  "app.asar",
  "node_modules",
  "better-sqlite3"
);

let database;
try {
  const Database = require(packagedModule);
  database = new Database(":memory:");
  database.exec("CREATE TABLE packaged_sqlite_check (id INTEGER PRIMARY KEY)");
  database
    .prepare("INSERT INTO packaged_sqlite_check (id) VALUES (?)")
    .run(1);
  const row = database
    .prepare("SELECT COUNT(*) AS total FROM packaged_sqlite_check")
    .get();
  if (row.total !== 1) {
    throw new Error("The packaged SQLite smoke test returned an invalid result.");
  }
  console.log("Packaged SQLite ABI check passed.");
} finally {
  database?.close();
}
