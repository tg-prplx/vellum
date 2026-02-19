import { Router } from "express";
import { db, roughTokenCount } from "../db.js";

const router = Router();

interface MessageRow {
  id: string;
  chat_id: string;
  branch_id: string;
  role: string;
  content: string;
  attachments: string | null;
  token_count: number;
  parent_id: string | null;
  deleted: number;
  created_at: string;
  character_name: string | null;
  sort_order: number;
}

function messageToJson(row: MessageRow) {
  let attachments: unknown[] = [];
  try {
    const parsed = JSON.parse(row.attachments || "[]");
    if (Array.isArray(parsed)) attachments = parsed;
  } catch {
    attachments = [];
  }
  return {
    id: row.id,
    chatId: row.chat_id,
    branchId: row.branch_id,
    role: row.role,
    content: row.content,
    attachments,
    tokenCount: row.token_count,
    createdAt: row.created_at,
    parentId: row.parent_id,
    characterName: row.character_name || undefined
  };
}

function getTimeline(chatId: string, branchId: string) {
  const rows = db.prepare(
    "SELECT * FROM messages WHERE chat_id = ? AND branch_id = ? AND deleted = 0 ORDER BY sort_order ASC, created_at ASC, id ASC"
  ).all(chatId, branchId) as MessageRow[];
  return rows.map(messageToJson);
}

const normalizeSortOrder = db.transaction((chatId: string, branchId: string) => {
  const rows = db.prepare(
    "SELECT id FROM messages WHERE chat_id = ? AND branch_id = ? AND deleted = 0 ORDER BY sort_order ASC, created_at ASC, id ASC"
  ).all(chatId, branchId) as { id: string }[];

  const update = db.prepare("UPDATE messages SET sort_order = ? WHERE id = ?");
  rows.forEach((row, index) => {
    update.run(index + 1, row.id);
  });
});

router.patch("/:id", (req, res) => {
  const content = String(req.body?.content ?? "");
  const row = db.prepare("SELECT * FROM messages WHERE id = ? AND deleted = 0")
    .get(req.params.id) as MessageRow | undefined;

  if (!row) {
    res.status(404).json({ error: "Message not found" });
    return;
  }

  db.prepare(
    "UPDATE messages SET content = ?, token_count = ? WHERE id = ? AND chat_id = ? AND branch_id = ? AND deleted = 0"
  ).run(content, roughTokenCount(content), row.id, row.chat_id, row.branch_id);

  res.json({ ok: true, timeline: getTimeline(row.chat_id, row.branch_id) });
});

router.delete("/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM messages WHERE id = ? AND deleted = 0")
    .get(req.params.id) as MessageRow | undefined;

  if (!row) {
    res.status(404).json({ error: "Message not found" });
    return;
  }

  const deleteMessage = db.transaction(() => {
    // UI delete should be precise: remove only the selected message.
    db.prepare(
      "UPDATE messages SET deleted = 1 WHERE id = ? AND chat_id = ? AND branch_id = ? AND deleted = 0"
    ).run(row.id, row.chat_id, row.branch_id);
    // Also remove tool/reasoning records directly attached to this message.
    db.prepare(
      "UPDATE messages SET deleted = 1 WHERE parent_id = ? AND chat_id = ? AND branch_id = ? AND role = 'tool' AND deleted = 0"
    ).run(row.id, row.chat_id, row.branch_id);
    normalizeSortOrder(row.chat_id, row.branch_id);
  });
  deleteMessage();

  res.json({ ok: true, timeline: getTimeline(row.chat_id, row.branch_id) });
});

export default router;
