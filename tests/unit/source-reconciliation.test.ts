import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDatabase, type SqliteDatabase } from "../../src/storage/database.js";
import { SourceReconciliationService } from "../../src/transactions/source-reconciliation.js";
import { expenseContribution } from "../../src/transactions/economic-treatment.js";
import { testConfig } from "../helpers.js";
import { CsvExporter } from "../../src/export/csv-exporter.js";
import { createDefaultExportSettings, ExportSettingsStore } from "../../src/settings/export-settings-store.js";

let root: string | undefined;
let db: SqliteDatabase | undefined;
afterEach(async () => { vi.restoreAllMocks(); db?.close(); db=undefined; if(root) await rm(root,{recursive:true,force:true}); root=undefined; });
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
  expect(database.prepare(`SELECT action, reference, kind, environment FROM transaction_reconciliation_events
    WHERE reference = ? ORDER BY recorded_at, rowid`).all(ref)).toEqual([
    { action: 'confirm', reference: ref, kind: 'settlement', environment: 'production' },
    { action: 'undo', reference: ref, kind: 'settlement', environment: 'production' }
  ]);
  const undoEvent = database.prepare(`SELECT first_amount_snapshot, second_amount_snapshot, currency_snapshot,
    confirmed_at FROM transaction_reconciliation_events WHERE reference = ? AND action = 'undo'`).get(ref) as
    { first_amount_snapshot: string; second_amount_snapshot: string; currency_snapshot: string; confirmed_at: string };
  expect([undoEvent.first_amount_snapshot, undoEvent.second_amount_snapshot].sort())
    .toEqual(['-120', '120']);
  expect(undoEvent.currency_snapshot).toBe('EUR');
  expect(undoEvent.confirmed_at).toMatch(/^20\d{2}-/u);
});
it('keeps only the explicitly selected representative of a manual/browser duplicate',async()=>{
  const {service,database}=await setup(); service.confirm('purchase','manual','duplicate');
  expect(database.prepare('SELECT movement_key,representative FROM transaction_reconciliations ORDER BY movement_key').all())
    .toEqual([{movement_key:'manual',representative:0},{movement_key:'purchase',representative:1}]);
});
it('uses one confirmation time and preserves the selected order in the undo event', async()=>{
  const {service,database}=await setup();
  let tick=0;
  vi.spyOn(Date.prototype,'toISOString').mockImplementation(()=>`2026-09-30T10:00:00.${String(tick++).padStart(3,'0')}Z`);
  const reference=service.confirm('purchase','manual','duplicate');
  const confirmation=database.prepare("SELECT confirmed_at FROM transaction_reconciliation_events WHERE reference=? AND action='confirm'").get(reference) as {confirmed_at:string};
  expect(database.prepare('SELECT DISTINCT confirmed_at FROM transaction_reconciliations WHERE reference=?').all(reference))
    .toEqual([{confirmed_at:confirmation.confirmed_at}]);
  service.undo(reference);
  expect(database.prepare("SELECT first_movement_key,second_movement_key,confirmed_at FROM transaction_reconciliation_events WHERE reference=? AND action='undo'").get(reference))
    .toEqual({first_movement_key:'purchase',second_movement_key:'manual',confirmed_at:confirmation.confirmed_at});
});
it('rejects incorrect amounts, same-account pairs, pending rows and another environment atomically',async()=>{
  const {service,insert,database}=await setup();
  insert('pending','manual','manual-card','-120','pending');
  insert('foreign','manual','manual-card','-120','booked','sandbox');
  for(const [first,second] of [['purchase','settlement'],['purchase','debit'],['purchase','pending'],['purchase','foreign']] as const)
    expect(()=>service.confirm(first,second,'duplicate')).toThrow();
  expect(database.prepare('SELECT COUNT(*) AS n FROM transaction_reconciliations').get()).toEqual({n:0});
});
it.each(['duplicate','settlement'] as const)('allows undo of a %s after both movement keys change',async(kind)=>{
  const {service,database}=await setup();
  const firstKey=kind==='duplicate'?'purchase':'settlement';
  const secondKey=kind==='duplicate'?'manual':'debit';
  const reference=service.confirm(firstKey,secondKey,kind);
  const confirmation=database.prepare("SELECT confirmed_at FROM transaction_reconciliation_events WHERE reference=? AND action='confirm'").get(reference) as {confirmed_at:string};
  for(const key of [firstKey,secondKey]) database.prepare('UPDATE transactions SET movement_key=? WHERE movement_key=?').run(`updated-${key}`,key);
  service.undo(reference);
  expect(database.prepare('SELECT COUNT(*) AS n FROM transaction_reconciliations WHERE reference=?').get(reference)).toEqual({n:0});
  const undo=database.prepare("SELECT first_movement_key,second_movement_key,confirmed_at FROM transaction_reconciliation_events WHERE reference=? AND action='undo'").get(reference) as {first_movement_key:string;second_movement_key:string;confirmed_at:string};
  expect([undo.first_movement_key,undo.second_movement_key].sort()).toEqual([`updated-${firstKey}`,`updated-${secondKey}`].sort());
  expect(undo.confirmed_at).toBe(confirmation.confirmed_at);
  expect(database.prepare("SELECT first_movement_key,second_movement_key FROM transaction_reconciliation_events WHERE reference=? AND action='confirm'").get(reference)).toEqual({first_movement_key:firstKey,second_movement_key:secondKey});
});
it('refuses to overwrite a confirmed relationship',async()=>{
  const {service}=await setup(); service.confirm('purchase','manual','duplicate');
  expect(()=>service.confirm('purchase','manual','duplicate')).toThrow('ALREADY_RECONCILED');
});
it.each(['kutxabank-browser','manual-card'])('rejects an inverted settlement for %s regardless of selection order',async(provider)=>{
  const {service,database,insert}=await setup();
  insert('credit','ais','enable-banking','120','booked');
  const cardKey=provider==='manual-card'?'manual':'purchase';
  for(const [firstKey,secondKey] of [[cardKey,'credit'],['credit',cardKey]] as const)
    expect(()=>service.confirm(firstKey,secondKey,'settlement')).toThrow('INVALID_RECONCILIATION');
  expect(database.prepare('SELECT COUNT(*) AS n FROM transaction_reconciliations').get()).toEqual({n:0});
  expect(database.prepare('SELECT COUNT(*) AS n FROM transaction_reconciliation_events').get()).toEqual({n:0});
});
it.each(['kutxabank-browser','manual-card'])('accepts a bank debit selected before the %s credit',async(provider)=>{
  const {service,insert}=await setup();
  insert('card-credit',provider==='manual-card'?'manual':'card',provider,'120','booked');
  expect(service.confirm('debit','card-credit','settlement')).toBeTruthy();
});

it('lists movements by the effective export date when booking date is absent',async()=>{
  const {service,database}=await setup();
  database.prepare("UPDATE transactions SET booking_date=NULL,value_date='2026-09-04' WHERE movement_key='debit'").run();
  database.prepare("UPDATE transactions SET booking_date=NULL,transaction_datetime='2026-09-06T12:00:00Z' WHERE movement_key='manual'").run();
  expect(service.list('2026-09-04','2026-09-06').map(row=>[row.movementKey,row.date]))
    .toEqual([['manual','2026-09-06'],['debit','2026-09-04']]);
});
it('hides unconfirmed pending movements but keeps a changed confirmed pair available for undo',async()=>{
  const {service,insert,database}=await setup();
  insert('pending','manual','manual-card','-120','pending');
  expect(service.list('2026-09-01','2026-09-01').map(row=>row.movementKey)).not.toContain('pending');
  service.confirm('purchase','manual','duplicate');
  database.prepare("UPDATE transactions SET status='pending' WHERE movement_key='purchase'").run();
  expect(service.list('2026-09-01','2026-09-01').map(row=>row.movementKey)).toContain('purchase');
});

it('exports confirmed economic amounts and invalidates treatment if a source amount changes',async()=>{
  const {service,database}=await setup();
  if (!root) throw new Error('Test fixture missing');
  const config=testConfig(root);
  const settings=createDefaultExportSettings('.',';');
  settings.format='csv'; settings.csv.includeBom=false;
  for(const column of settings.columns) column.enabled='field' in column && ['movementKey','amount','expenseAmount','economicTreatment'].includes(column.field);
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
  for(const column of settings.columns) column.enabled='field' in column && ['movementKey','expenseAmount','economicTreatment'].includes(column.field);
  await new ExportSettingsStore(config.exportSettingsPath,settings).save(settings);
  service.confirm('purchase','manual','duplicate');
  database.prepare("UPDATE accounts SET export_enabled=0 WHERE id='card'").run();
  const output=await new CsvExporter(config,database).export();
  const rows=(await readFile(output.path,'utf8')).split(/\r?\n/);
  expect(rows).toContain('manual;€120 EUR;review-required');
});
it('keeps the card settlement contribution zero when the AIS account is excluded',async()=>{
  const {service,database}=await setup();
  if (!root) throw new Error('Test fixture missing');
  const config=testConfig(root);
  const settings=createDefaultExportSettings('.',';');
  settings.format='csv'; settings.csv.includeBom=false;
  for(const column of settings.columns) column.enabled='field' in column && ['movementKey','expenseAmount','economicTreatment'].includes(column.field);
  await new ExportSettingsStore(config.exportSettingsPath,settings).save(settings);
  service.confirm('settlement','debit','settlement');
  database.prepare("UPDATE accounts SET export_enabled=0 WHERE id='ais'").run();
  const output=await new CsvExporter(config,database).export();
  const rows=(await readFile(output.path,'utf8')).split(/\r?\n/);
  expect(rows).toContain('settlement;€0 EUR;internal-transfer');
  expect(rows).toContain('purchase;€120 EUR;review-required');
  expect(rows.some(row=>row.startsWith('debit;'))).toBe(false);
});
it.each(['kutxabank-browser','manual-card'])('counts the AIS debit when the %s card is excluded from export',async(provider)=>{
  const {service,database,insert}=await setup();
  if (!root) throw new Error('Test fixture missing');
  const cardId=provider==='manual-card'?'manual':'card';
  insert('card-credit',cardId,provider,'120','booked');
  service.confirm('card-credit','debit','settlement');
  database.prepare('UPDATE accounts SET export_enabled=0 WHERE id=?').run(cardId);
  const config=testConfig(root);
  const settings=createDefaultExportSettings('.',';');
  settings.format='csv'; settings.csv.includeBom=false;
  for(const column of settings.columns) column.enabled='field' in column && ['movementKey','expenseAmount','economicTreatment'].includes(column.field);
  await new ExportSettingsStore(config.exportSettingsPath,settings).save(settings);
  const output=await new CsvExporter(config,database).export();
  const rows=(await readFile(output.path,'utf8')).split(/\r?\n/);
  expect(rows).toContain('debit;€120 EUR;review-required');
  expect(rows.some(row=>row.startsWith('card-credit;'))).toBe(false);
});
