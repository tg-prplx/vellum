import { Router } from "express";
import { db, newId, now } from "../db.js";
import { normalizeLoreBookEntries } from "../domain/lorebooks.js";

const router = Router();

interface LoreBookRow {
  id: string;
  name: string;
  description: string | null;
  entries_json: string;
  source_character_id: string | null;
  created_at: string;
  updated_at: string;
}

function rowToJson(row: LoreBookRow) {
  let entries = normalizeLoreBookEntries([]);
  try {
    entries = normalizeLoreBookEntries(JSON.parse(row.entries_json || "[]"));
  } catch {
    entries = [];
  }

  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    entries,
    sourceCharacterId: row.source_character_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

router.get("/", (_req, res) => {
  const rows = db.prepare("SELECT * FROM lorebooks ORDER BY updated_at DESC, created_at DESC").all() as LoreBookRow[];
  res.json(rows.map(rowToJson));
});

router.get("/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM lorebooks WHERE id = ?").get(req.params.id) as LoreBookRow | undefined;
  if (!row) {
    res.status(404).json({ error: "LoreBook not found" });
    return;
  }
  res.json(rowToJson(row));
});

router.post("/", (req, res) => {
  const id = newId();
  const ts = now();
  const name = String(req.body?.name || "").trim() || "New LoreBook";
  const description = String(req.body?.description || "").trim();
  const entries = normalizeLoreBookEntries(req.body?.entries);
  const sourceCharacterId = req.body?.sourceCharacterId ? String(req.body.sourceCharacterId) : null;

  db.prepare(
    "INSERT INTO lorebooks (id, name, description, entries_json, source_character_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(id, name, description, JSON.stringify(entries), sourceCharacterId, ts, ts);

  const row = db.prepare("SELECT * FROM lorebooks WHERE id = ?").get(id) as LoreBookRow;
  res.json(rowToJson(row));
});

router.put("/:id", (req, res) => {
  const id = req.params.id;
  const existing = db.prepare("SELECT * FROM lorebooks WHERE id = ?").get(id) as LoreBookRow | undefined;
  if (!existing) {
    res.status(404).json({ error: "LoreBook not found" });
    return;
  }

  const parsedExistingEntries = (() => {
    try {
      return normalizeLoreBookEntries(JSON.parse(existing.entries_json || "[]"));
    } catch {
      return [];
    }
  })();

  const name = typeof req.body?.name === "string" ? req.body.name.trim() : existing.name;
  const description = typeof req.body?.description === "string" ? req.body.description.trim() : (existing.description || "");
  const entries = req.body?.entries !== undefined
    ? normalizeLoreBookEntries(req.body.entries)
    : parsedExistingEntries;

  const nextName = name || existing.name;
  const sourceCharacterId = req.body?.sourceCharacterId === undefined
    ? existing.source_character_id
    : (req.body.sourceCharacterId ? String(req.body.sourceCharacterId) : null);

  db.prepare(
    "UPDATE lorebooks SET name = ?, description = ?, entries_json = ?, source_character_id = ?, updated_at = ? WHERE id = ?"
  ).run(nextName, description, JSON.stringify(entries), sourceCharacterId, now(), id);

  const row = db.prepare("SELECT * FROM lorebooks WHERE id = ?").get(id) as LoreBookRow;
  res.json(rowToJson(row));
});

router.delete("/:id", (req, res) => {
  const id = req.params.id;
  db.prepare("UPDATE chats SET lorebook_id = NULL WHERE lorebook_id = ?").run(id);
  db.prepare("UPDATE characters SET lorebook_id = NULL WHERE lorebook_id = ?").run(id);
  db.prepare("DELETE FROM lorebooks WHERE id = ?").run(id);
  res.json({ ok: true });
});

export default router;
