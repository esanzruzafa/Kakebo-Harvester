import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createDatabase, type SqliteDatabase } from "../../src/storage/database.js";
import { SourceReconciliationService } from "../../src/transactions/source-reconciliation.js";
import { expenseContribution } from "../../src/transactions/economic-treatment.js";
import { testConfig } from "../helpers.js";
import { CsvExporter } from "../../src/export/csv-exporter.js";
import { createDefaultExportSettings, ExportSettingsStore } from "../../src/settings/export-settings-store.js";

let root: string | undefined;
let db: SqliteDatabase | undefined;
afterEach(async () => { db?.close(); db=undefined; if(root) await rm(root,{recursive:true,force:true}); root=undefined; });
async function setup() {
  root=await mkdtemp(join(tmpdir(),"kakebo-reconciliation-"));
  const database=createDatabase(testConfig(root).databasePath); db=database;
  database.prepare(`INSERT INTO bank_connections(id,provider,environment,bank_name,bank_country,psu_type,alias,status,created_at)
    VALUES ('connection','kutxabank-browser','production','Bank','ES','personal','Test','LOCAL','2026-01-01')`).run();
  for(const id of ['card','ais','manual']) database.prepare(`INSERT INTO accounts(id,bank_connection_id,provider_account_id,first_seen_at,last_seen_at)
    VALUES (?,'connection',?,'2026-01-01','2026-01-01')`).run(id,id);
  const insert=(key:string,account:string,provider:string,amount:string,status="unknown",environment="production")=>database.prepare(`INSERT INTO transactions
    (id,movement_key,reconciliation_key,provider,environment,bank_connection_id,account_id,status,booking_date,amount,currency,direction,first_seen_at,last_seen_at,imported_at,raw_fingerprint)
    VALUES (?,?,?,?,?,'connection',?,?,'2026-09-01',?,'EUR','expense','2026-01-01','2026-01-01','2026-01-01','test')`).run(key,key,key,provider,environment,account,status,amount);
  insert('purchase','card','kutxabank-browser','-120');
  insert('settlement','card','kutxabank-browser','120');
  insert('debit','ais','enable-banking','-120','booked');
  insert('manual','manual','manual-card','-120','booked');
  return {database,insert,service:new SourceReconciliationService(database,'production')};
}
it('retains original amounts while a confirmed settlement contributes zero', async()=>{
  const {service,database}=await setup();
  const ref=service.confirm('settlement','debit','settlement');
  expect(ref).toBeTruthy();
  expect(database.prepare('SELECT COUNT(*) AS n FROM transactions').get()).toEqual({n:4});
  expect(database.prepare('SELECT COUNT(*) AS n FROM transaction_reconciliations WHERE reference=?').get(ref)).toEqual({n:2});
  expect(expenseContribution({amount:'-120',treatment:'internal-transfer',representative:true})).toBe('0');
  expect(expenseContribution({amount:'-120',treatment:'normal',representative:true})).toBe('120');
  service.undo(ref);
  expect(database.prepare('SELECT COUNT(*) AS n FROM transaction_reconciliations').get()).toEqual({n:0});
});
it('keeps only the explicitly selected representative of a manual/browser duplicate',async()=>{
  const {service,database}=await setup(); service.confirm('purchase','manual','duplicate');
  expect(database.prepare('SELECT movement_key,representative FROM transaction_reconciliations ORDER BY movement_key').all())
    .toEqual([{movement_key:'manual',representative:0},{movement_key:'purchase',representative:1}]);
});
it('rejects incorrect amounts, same-account pairs, pending rows and another environment atomically',async()=>{
  const {service,insert,database}=await setup();
  insert('pending','manual','manual-card','-120','pending');
  insert('foreign','manual','manual-card','-120','booked','sandbox');
  for(const [first,second] of [['purchase','settlement'],['purchase','debit'],['purchase','pending'],['purchase','foreign']] as const)
    expect(()=>service.confirm(first,second,'duplicate')).toThrow();
  expect(database.prepare('SELECT COUNT(*) AS n FROM transaction_reconciliations').get()).toEqual({n:0});
});
it('refuses to overwrite a confirmed relationship',async()=>{
  const {service}=await setup(); service.confirm('purchase','manual','duplicate');
  expect(()=>service.confirm('purchase','manual','duplicate')).toThrow('ALREADY_RECONCILED');
});

it('exports confirmed economic amounts and invalidates treatment if a source amount changes',async()=>{
  const {service,database}=await setup();
  if (!root) throw new Error('Test fixture missing');
  const config=testConfig(root);
  const settings=createDefaultExportSettings('.',';');
  settings.format='csv'; settings.csv.includeBom=false;
  for(const column of settings.columns) column.enabled=['movementKey','amount','expenseAmount','economicTreatment'].includes(column.field);
  await new ExportSettingsStore(config.exportSettingsPath,settings).save(settings);
  service.confirm('settlement','debit','settlement');
  const exporter=new CsvExporter(config,database);
  const initial=await exporter.export();
  const rows=(await readFile(initial.path,'utf8')).split(/\r?\n/);
  expect(rows).toContain('debit;-€120 EUR;€0 EUR;internal-transfer');
  expect(rows).toContain('purchase;-€120 EUR;€120 EUR;review-required');
  database.prepare("UPDATE transactions SET amount='121' WHERE movement_key='settlement'").run();
  const changed=await exporter.export();
  const changedRows=(await readFile(changed.path,'utf8')).split(/\r?\n/);
  expect(changedRows).toContain('debit;-€120 EUR;€120 EUR;review-required');
  expect(changedRows).toContain('settlement;€121 EUR;-€121 EUR;review-required');
});

it('does not suppress the remaining copy when its representative is excluded from export',async()=>{
  const {service,database}=await setup();
  if (!root) throw new Error('Test fixture missing');
  const config=testConfig(root);
  const settings=createDefaultExportSettings('.',';');
  settings.format='csv'; settings.csv.includeBom=false;
  for(const column of settings.columns) column.enabled=['movementKey','expenseAmount','economicTreatment'].includes(column.field);
  await new ExportSettingsStore(config.exportSettingsPath,settings).save(settings);
  service.confirm('purchase','manual','duplicate');
  database.prepare("UPDATE accounts SET export_enabled=0 WHERE id='card'").run();
  const output=await new CsvExporter(config,database).export();
  const rows=(await readFile(output.path,'utf8')).split(/\r?\n/);
  expect(rows).toContain('manual;€120 EUR;review-required');
});
