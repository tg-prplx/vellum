import { Router } from "express";
import { db, maskApiKey, isLocalhostUrl } from "../db.js";
import { fetchKoboldModels, normalizeProviderType, testKoboldConnection } from "../services/providerApi.js";

const router = Router();

interface ProviderRow {
  id: string;
  name: string;
  base_url: string;
  api_key_cipher: string;
  proxy_url: string | null;
  full_local_only: number;
  provider_type: string;
}

function rowToProfile(row: ProviderRow) {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    apiKeyMasked: maskApiKey(row.api_key_cipher),
    proxyUrl: row.proxy_url,
    fullLocalOnly: Boolean(row.full_local_only),
    providerType: normalizeProviderType(row.provider_type)
  };
}

function getSettings() {
  const row = db.prepare("SELECT payload FROM settings WHERE id = 1").get() as { payload: string };
  return JSON.parse(row.payload);
}

router.post("/", (req, res) => {
  const { id, name, baseUrl, apiKey, proxyUrl, fullLocalOnly, providerType } = req.body;
  const normalizedType = normalizeProviderType(providerType);

  db.prepare(`
    INSERT INTO providers (id, name, base_url, api_key_cipher, proxy_url, full_local_only, provider_type)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      base_url = excluded.base_url,
      api_key_cipher = excluded.api_key_cipher,
      proxy_url = excluded.proxy_url,
      full_local_only = excluded.full_local_only,
      provider_type = excluded.provider_type
  `).run(id, name, baseUrl, apiKey || "local-key", proxyUrl || null, fullLocalOnly ? 1 : 0, normalizedType);

  const row = db.prepare("SELECT * FROM providers WHERE id = ?").get(id) as ProviderRow;
  res.json(rowToProfile(row));
});

router.get("/", (_req, res) => {
  const rows = db.prepare("SELECT * FROM providers ORDER BY name ASC").all() as ProviderRow[];
  res.json(rows.map(rowToProfile));
});

router.get("/:id/models", async (req, res) => {
  const row = db.prepare("SELECT * FROM providers WHERE id = ?").get(req.params.id) as ProviderRow | undefined;
  if (!row) { res.json([]); return; }

  const settings = getSettings();
  if (settings.fullLocalMode && !isLocalhostUrl(row.base_url)) {
    res.status(403).json({ error: "Provider blocked by Full Local Mode" });
    return;
  }
  if (row.full_local_only && !isLocalhostUrl(row.base_url)) {
    res.status(403).json({ error: "Provider is set to Local-only. Disable Local-only for external URLs." });
    return;
  }

  try {
    const providerType = normalizeProviderType(row.provider_type);
    if (providerType === "koboldcpp") {
      const koboldModels = await fetchKoboldModels(row);
      res.json(koboldModels.map((id) => ({ id })));
      return;
    }

    const response = await fetch(`${row.base_url}/models`, {
      headers: { Authorization: `Bearer ${row.api_key_cipher}` }
    });
    if (!response.ok) { res.json([]); return; }
    const body = await response.json() as { data?: { id: string }[] };
    const models = (body.data ?? []).map((m) => ({ id: m.id }));
    res.json(models);
  } catch {
    res.json([]);
  }
});

router.post("/set-active", (req, res) => {
  const { providerId, modelId } = req.body;
  const settings = getSettings();
  const updated = { ...settings, activeProviderId: providerId, activeModel: modelId };
  db.prepare("UPDATE settings SET payload = ? WHERE id = 1").run(JSON.stringify(updated));
  res.json(updated);
});

router.post("/:id/test", async (req, res) => {
  const row = db.prepare("SELECT * FROM providers WHERE id = ?").get(req.params.id) as ProviderRow | undefined;
  if (!row) { res.json(false); return; }

  const settings = getSettings();
  if (settings.fullLocalMode && !isLocalhostUrl(row.base_url)) {
    res.json(false);
    return;
  }
  if (row.full_local_only && !isLocalhostUrl(row.base_url)) {
    res.json(false);
    return;
  }

  const providerType = normalizeProviderType(row.provider_type);
  if (providerType === "koboldcpp") {
    const ok = await testKoboldConnection(row);
    res.json(ok);
    return;
  }

  res.json(true);
});

export default router;
