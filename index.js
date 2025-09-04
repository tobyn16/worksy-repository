import express from "express";
import cors from "cors";
import helmet from "helmet";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import CryptoJS from "crypto-js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({ origin: true }));
app.use(express.json({ limit: "512kb" }));

// ENV
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const SERVER_HMAC_SECRET = process.env.SERVER_HMAC_SECRET || "";

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const supa = createClient(SUPABASE_URL, SUPABASE_KEY);

// Helpers
const nowISO = () => new Date().toISOString();
const uuidv4 = () =>
  "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0,
      v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
const audit = async (sessionId, type, meta = {}) => {
  try {
    await supa.from("audits").insert({ session_id: sessionId, type, meta });
  } catch {}
};
const requireAdmin = (req, res, next) => {
  if (!ADMIN_KEY || req.headers["x-admin-key"] !== ADMIN_KEY)
    return res.status(401).json({ error: "Unauthorized" });
  next();
};

// Simple amber policy
const POLICY = {
  amber: {
    allowed: [
      "Brainstorming/plan",
      "Outlines",
      "Concept explanations",
      "Reading lists",
      "Feedback on draft",
      "Citation guidance",
    ],
    notAllowed: [
      "Producing final text",
      "Writing assignment verbatim",
      "Helping invigilated exams",
      "Evading originality checks",
    ],
    redKeywords: [
      "invigilated",
      "exam",
      "closed book",
      "test paper",
      "final exam",
      "write my assignment",
      "full essay",
      "complete the coursework",
      "write the lab report for me",
    ],
    reminder:
      "AMBER: Worksy coaches your thinking but will not write final submission text. All usage is logged.",
  },
};
const isDisallowed = (t = "") =>
  POLICY.amber.redKeywords.some((k) => t.toLowerCase().includes(k));

// Static
app.use(express.static(path.join(__dirname, "public")));

// Health & ping
app.get("/api/ping", (_req, res) => res.json({ ok: true }));
app.get("/api/health", async (_req, res) => {
  try {
    const { error } = await supa.from("assignments").select("id").limit(1);
    if (error) throw error;
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false });
  }
});

// Policy fetch
app.get("/api/policy", async (req, res) => {
  try {
    const id = req.query.assignmentId;
    if (!id) return res.status(400).json({ error: "Missing assignmentId" });
    const { data: a } = await supa
      .from("assignments")
      .select("*")
      .eq("id", id)
      .single();
    if (!a) return res.status(404).json({ error: "Assignment not found" });
    res.json({
      reminder: POLICY.amber.reminder,
      allowed: POLICY.amber.allowed,
      notAllowed: POLICY.amber.notAllowed,
      caps: {
        prompt_cap: a.prompt_cap,
        output_token_cap: a.output_token_cap,
        input_token_cap: a.input_token_cap,
      },
      module: { code: a.module_code, title: a.title },
      mode: a.mode,
      due_at: a.due_at,
      model: a.model,
      templates: a.prompt_templates || [],
    });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

// Consent + notes
app.post("/api/session/consent", async (req, res) => {
  try {
    const { sessionId } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: "No sessionId" });
    await supa
      .from("sessions")
      .update({ consent_at: nowISO() })
      .eq("id", sessionId);
    await audit(sessionId, "consent");
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});
app.post("/api/session/notes", async (req, res) => {
  try {
    const { sessionId, notes } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: "No sessionId" });
    const { data: s } = await supa
      .from("sessions")
      .select("submitted")
      .eq("id", sessionId)
      .single();
    if (s?.submitted) return res.status(400).json({ error: "Session locked" });
    await supa
      .from("sessions")
      .update({ notes, last_activity_at: nowISO() })
      .eq("id", sessionId);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

// In-memory rate limit per session
const rl = new Map();
function rateLimited(sessionId, n = 3, windowS = 10) {
  if (!sessionId) return false;
  const now = Date.now();
  const a = (rl.get(sessionId) || []).filter((t) => now - t < windowS * 1000);
  a.push(now);
  rl.set(sessionId, a);
  return a.length > n;
}

// Chat
app.post("/api/chat", async (req, res) => {
  try {
    const { assignmentId, sessionId, studentRef, message, locale } =
      req.body || {};
    if (!assignmentId || !studentRef || !message)
      return res.status(400).json({ error: "Missing fields" });

    const { data: a } = await supa
      .from("assignments")
      .select("*")
      .eq("id", assignmentId)
      .single();
    if (!a) return res.status(400).json({ error: "Assignment not found" });

    if (a.mode === "red")
      return res
        .status(400)
        .json({ error: "This task is RED (invigilated). AI not allowed." });
    if (a.due_at && new Date(a.due_at).getTime() < Date.now())
      return res
        .status(400)
        .json({ error: "Assignment past deadline and locked." });

    // Ensure session
    let sid = sessionId,
      newSession = false;
    if (!sid) {
      const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
      const { data: s, error: e } = await supa
        .from("sessions")
        .insert({
          assignment_id: assignmentId,
          student_ref: studentRef,
          locale: locale || "en-GB",
          ip,
        })
        .select("id")
        .single();
      if (e) return res.status(500).json({ error: "Could not create session" });
      sid = s.id;
      newSession = true;
      await supa
        .from("sessions")
        .update({ policy_shown_at: nowISO() })
        .eq("id", sid);
      await audit(sid, "policy_shown");
    }
    const { data: sl } = await supa
      .from("sessions")
      .select("submitted")
      .eq("id", sid)
      .single();
    if (sl?.submitted)
      return res
        .status(400)
        .json({ error: "Session locked after submission", sessionId: sid });

    // Rate limit
    if (rateLimited(sid, a.rate_limit_n ?? 3, a.rate_limit_window_s ?? 10))
      return res
        .status(429)
        .json({ error: "Too many requests. Please slow down." });

    // Prompt cap
    const { count: used } = await supa
      .from("chat_events")
      .select("id", { count: "exact", head: true })
      .eq("session_id", sid)
      .eq("role", "user");
    if ((used ?? 0) >= a.prompt_cap)
      return res
        .status(400)
        .json({ error: "Prompt cap reached", sessionId: sid });

    // Log user
    await supa
      .from("chat_events")
      .insert({ session_id: sid, role: "user", content: message });

    // Amber guard
    if (a.mode === "amber" && isDisallowed(message)) {
      const reminder = `Policy (AMBER): ${POLICY.amber.reminder}\nAllowed: ${POLICY.amber.allowed.join("; ")}\nNot allowed: ${POLICY.amber.notAllowed.join("; ")}\nTry: outline, plan, feedback, concepts.`;
      await supa.from("chat_events").insert({
        session_id: sid,
        role: "assistant",
        content: reminder,
        model: "policy",
        total_tokens: 0,
      });
      await supa
        .from("sessions")
        .update({ last_activity_at: nowISO() })
        .eq("id", sid);
      return res.json({
        sessionId: sid,
        reply: reminder,
        usage: { total_tokens: 0 },
        promptsUsed: (used ?? 0) + 1,
        promptCap: a.prompt_cap,
      });
    }

    const systemPrompt = `
You are Worksy (University of Leicester AI Sandbox).
Mode: ${a.mode?.toUpperCase()}.
Coach the student; do NOT produce final submission text. UK spelling; short paragraphs.
Stay under ~${a.output_token_cap} tokens. Encourage sources & integrity.
Module: ${a.module_code || "N/A"} — ${a.title}.
`.trim();

    const model = a.model || "gpt-4o-mini";
    const completion = await openai.chat.completions.create({
      model,
      max_tokens: a.output_token_cap,
      temperature: 0.5,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message },
      ],
    });
    let reply = completion.choices?.[0]?.message?.content ?? "No reply.";
    const usage = completion.usage ?? {};
    const pTok = usage.prompt_tokens ?? null,
      cTok = usage.completion_tokens ?? null;
    const tTok = usage.total_tokens ?? (pTok || 0) + (cTok || 0);

    if (newSession) {
      const banner = `📘 Worksy (AMBER): ${POLICY.amber.reminder}\nAllowed: ${POLICY.amber.allowed.join("; ")}\nNot allowed: ${POLICY.amber.notAllowed.join("; ")}`;
      await supa.from("chat_events").insert({
        session_id: sid,
        role: "assistant",
        content: banner,
        model: "policy",
        total_tokens: 0,
      });
      reply = `${banner}\n\n${reply}`;
    }
    await supa.from("chat_events").insert({
      session_id: sid,
      role: "assistant",
      content: reply,
      prompt_tokens: pTok,
      completion_tokens: cTok,
      total_tokens: tTok,
      model,
    });
    await supa
      .from("sessions")
      .update({ last_activity_at: nowISO() })
      .eq("id", sid);

    res.json({
      sessionId: sid,
      reply,
      usage,
      promptsUsed: (used ?? 0) + 1,
      promptCap: a.prompt_cap,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

// Tab switch
app.post("/api/tab-switch", async (req, res) => {
  try {
    const { sessionId } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: "No sessionId" });
    const { data: s } = await supa
      .from("sessions")
      .select("tab_switches")
      .eq("id", sessionId)
      .single();
    const next = (s?.tab_switches ?? 0) + 1;
    await supa
      .from("sessions")
      .update({ tab_switches: next, last_activity_at: nowISO() })
      .eq("id", sessionId);
    res.json({ tabSwitches: next });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

// Index generate
app.post("/api/index/generate", async (req, res) => {
  try {
    const { sessionId } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: "No sessionId" });
    const { data: s } = await supa
      .from("sessions")
      .select("*")
      .eq("id", sessionId)
      .single();
    const { data: a } = await supa
      .from("assignments")
      .select("*")
      .eq("id", s.assignment_id)
      .single();
    const { data: ev } = await supa
      .from("chat_events")
      .select(
        "role,content,created_at,prompt_tokens,completion_tokens,total_tokens,model",
      )
      .eq("session_id", sessionId)
      .order("id");

    const index = {
      assignment: {
        id: s.assignment_id,
        module: a.module_code,
        title: a.title,
        due_at: a.due_at,
        mode: a.mode,
        model: a.model,
      },
      student: s.student_ref,
      caps: {
        prompt_cap: a.prompt_cap,
        input_token_cap: a.input_token_cap,
        output_token_cap: a.output_token_cap,
      },
      session: {
        id: s.id,
        started_at: s.started_at,
        ended_at: s.ended_at,
        tab_switches: s.tab_switches,
        notes: s.notes || null,
      },
      policy_version: a.policy_version ?? 1,
      config_version: a.config_version ?? 1,
      events: ev || [],
      generated_at: nowISO(),
    };
    const json = JSON.stringify(index);
    const hash = CryptoJS.SHA256(json).toString();
    const hmac = SERVER_HMAC_SECRET
      ? CryptoJS.HmacSHA256(json, SERVER_HMAC_SECRET).toString()
      : null;

    const { data: idxRow, error: idxErr } = await supa
      .from("ai_index")
      .insert({
        assignment_id: s.assignment_id,
        student_id: s.student_ref,
        session_id: s.id,
        index_json: index,
        hash,
        hmac,
        policy_version: index.policy_version,
        config_version: index.config_version,
      })
      .select("id")
      .single();
    if (idxErr)
      return res.status(500).json({ error: "Could not persist AI Index" });

    await supa
      .from("sessions")
      .update({ index_id: idxRow.id, last_activity_at: nowISO() })
      .eq("id", s.id);
    await audit(s.id, "index_generated", { index_id: idxRow.id, hash });

    res.json({ id: idxRow.id, hash, hmac, index });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

// Latest index
app.get("/api/index/latest", async (req, res) => {
  try {
    const sessionId = req.query.sessionId;
    if (!sessionId) return res.status(400).json({ error: "Missing sessionId" });
    const { data: s } = await supa
      .from("sessions")
      .select("index_id")
      .eq("id", sessionId)
      .single();
    if (!s?.index_id)
      return res.status(404).json({ error: "No index for this session" });
    const { data: idx } = await supa
      .from("ai_index")
      .select("*")
      .eq("id", s.index_id)
      .single();
    if (!idx) return res.status(404).json({ error: "Index not found" });
    res.json({
      id: idx.id,
      hash: idx.hash,
      hmac: idx.hmac,
      index: idx.index_json,
    });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

// Upload index to Storage
app.post("/api/index/upload", async (req, res) => {
  try {
    const { sessionId } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: "No sessionId" });
    const { data: s } = await supa
      .from("sessions")
      .select("id,index_id,assignment_id,student_ref")
      .eq("id", sessionId)
      .single();
    if (!s?.index_id)
      return res.status(400).json({ error: "Generate AI Index first." });
    const { data: idx } = await supa
      .from("ai_index")
      .select("index_json,hash,hmac,id")
      .eq("id", s.index_id)
      .single();

    const content = JSON.stringify(
      { ...idx.index_json, hash: idx.hash, hmac: idx.hmac },
      null,
      2,
    );
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const pathKey = `${s.assignment_id}/${sessionId}/ai-index-${ts}.json`;

    const blob = new Blob([content], { type: "application/json" });
    const { error: upErr } = await supa.storage
      .from("ai-index")
      .upload(pathKey, blob, { upsert: true, contentType: "application/json" });
    if (upErr) return res.status(500).json({ error: "Upload failed" });

    await supa
      .from("ai_index")
      .update({ storage_path: pathKey })
      .eq("id", idx.id);
    const { data: signed } = await supa.storage
      .from("ai-index")
      .createSignedUrl(pathKey, 60 * 60 * 24 * 365);
    res.json({ url: signed?.signedUrl || null, path: pathKey });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

// Verify (by AI index id)
app.get("/api/index/verify", async (req, res) => {
  try {
    const id = req.query.id;
    if (!id) return res.status(400).json({ ok: false, error: "Missing id" });
    const { data: idx } = await supa
      .from("ai_index")
      .select("*")
      .eq("id", id)
      .single();
    if (!idx) return res.status(404).json({ ok: false, error: "Not found" });
    const json = JSON.stringify(idx.index_json);
    const recomputedHash = CryptoJS.SHA256(json).toString();
    const recomputedHmac = SERVER_HMAC_SECRET
      ? CryptoJS.HmacSHA256(json, SERVER_HMAC_SECRET).toString()
      : null;
    const hashOK = recomputedHash === idx.hash;
    const hmacOK =
      (!idx.hmac && !recomputedHmac) || recomputedHmac === idx.hmac;
    res.json({
      ok: hashOK && hmacOK,
      hashOK,
      hmacOK,
      policy_version: idx.policy_version,
      config_version: idx.config_version,
    });
  } catch {
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Submit & lock
app.post("/api/submit", async (req, res) => {
  try {
    const { sessionId } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: "No sessionId" });
    const { data: s } = await supa
      .from("sessions")
      .select("id,index_id,submitted")
      .eq("id", sessionId)
      .single();
    if (s?.submitted) return res.json({ ok: true, alreadySubmitted: true });
    if (!s?.index_id)
      return res
        .status(400)
        .json({ error: "Generate AI Index before submitting." });
    await supa
      .from("sessions")
      .update({ submitted: true, submitted_at: nowISO() })
      .eq("id", sessionId);
    await audit(sessionId, "submit");
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

// Admin APIs
app.get("/api/admin/assignments", requireAdmin, async (_req, res) => {
  const { data } = await supa
    .from("assignments")
    .select(
      "id,module_code,title,prompt_cap,output_token_cap,input_token_cap,mode,due_at",
    )
    .order("module_code");
  res.json({ assignments: data || [] });
});
app.post("/api/admin/assignments/import", requireAdmin, async (req, res) => {
  try {
    const rows = req.body?.rows;
    if (!Array.isArray(rows) || !rows.length)
      return res.status(400).json({ error: "rows[] required" });
    const upserts = rows.map((r) => ({
      id: r.id || uuidv4(),
      module_code: r.module_code,
      title: r.title,
      prompt_cap: Number(r.prompt_cap) || 100,
      output_token_cap: Number(r.output_token_cap) || 500,
      input_token_cap: Number(r.input_token_cap) || 1000,
      mode: (r.mode || "amber").toLowerCase(),
      due_at: r.due_at || null,
      model: r.model || "gpt-4o-mini",
    }));
    const { error } = await supa
      .from("assignments")
      .upsert(upserts, { onConflict: "id" });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, count: upserts.length });
  } catch (e) {
    res.status(500).json({ error: "Server error" });
  }
});
app.get("/api/admin/sessions", requireAdmin, async (req, res) => {
  const { assignmentId, studentRef, from, to, lockedOnly, highTabs } =
    req.query;
  let q = supa
    .from("sessions")
    .select(
      "id,assignment_id,student_ref,started_at,submitted,submitted_at,tab_switches,last_activity_at,risk_score,index_id",
    )
    .order("started_at", { ascending: false });
  if (assignmentId) q = q.eq("assignment_id", assignmentId);
  if (studentRef) q = q.ilike("student_ref", `%${studentRef}%`);
  if (lockedOnly === "true") q = q.eq("submitted", true);
  if (from) q = q.gte("started_at", from);
  if (to) q = q.lte("started_at", to);
  const { data: rows } = await q;
  const flagged = (rows || []).map((r) => ({
    ...r,
    risk_score: (r.tab_switches || 0) >= 10 ? 0.8 : r.submitted ? 0.2 : 0,
  }));
  const filtered =
    highTabs === "true" ? flagged.filter((r) => r.tab_switches >= 10) : flagged;
  res.json({ sessions: filtered });
});
app.get("/api/admin/sessions/:id/events", requireAdmin, async (req, res) => {
  const id = req.params.id;
  const { data: s } = await supa
    .from("sessions")
    .select("index_id")
    .eq("id", id)
    .single();
  const { data } = await supa
    .from("chat_events")
    .select(
      "role,content,created_at,prompt_tokens,completion_tokens,total_tokens,model",
    )
    .eq("session_id", id)
    .order("id");
  // Fingerprint status (if index exists)
  let fingerprint = null;
  if (s?.index_id) {
    const { data: idx } = await supa
      .from("ai_index")
      .select("*")
      .eq("id", s.index_id)
      .single();
    if (idx) {
      const json = JSON.stringify(idx.index_json);
      const recomputedHash = CryptoJS.SHA256(json).toString();
      const recomputedHmac = SERVER_HMAC_SECRET
        ? CryptoJS.HmacSHA256(json, SERVER_HMAC_SECRET).toString()
        : null;
      fingerprint = {
        index_id: idx.id,
        hashOK: recomputedHash === idx.hash,
        hmacOK: (!idx.hmac && !recomputedHmac) || recomputedHmac === idx.hmac,
        hash: idx.hash,
      };
    }
  }
  res.json({ events: data || [], fingerprint });
});
app.get("/api/admin/export", requireAdmin, async (req, res) => {
  const { assignmentId } = req.query;
  if (!assignmentId)
    return res.status(400).json({ error: "assignmentId required" });
  const { data } = await supa
    .from("sessions")
    .select(
      "id,student_ref,started_at,submitted,submitted_at,tab_switches,risk_score",
    )
    .eq("assignment_id", assignmentId);
  let csv =
    "session_id,student_ref,started_at,submitted,submitted_at,tab_switches,risk_score\n";
  (data || []).forEach((r) => {
    csv += `${r.id},${JSON.stringify(r.student_ref)},${r.started_at},${r.submitted},${r.submitted_at || ""},${r.tab_switches},${r.risk_score || 0}\n`;
  });
  res.setHeader("Content-Type", "text/csv");
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="worksy-sessions.csv"',
  );
  res.send(csv);
});
app.get("/api/admin/metrics", requireAdmin, async (req, res) => {
  const { assignmentId } = req.query;
  if (!assignmentId)
    return res.status(400).json({ error: "assignmentId required" });
  const { data: sessions } = await supa
    .from("sessions")
    .select("id,submitted,tab_switches")
    .eq("assignment_id", assignmentId);
  const ids = (sessions || []).map((s) => s.id);
  let totalPrompts = 0,
    totalTokens = 0;
  if (ids.length) {
    const { data: ev } = await supa
      .from("chat_events")
      .select("session_id,role,total_tokens")
      .in("session_id", ids);
    for (const e of ev || []) {
      if (e.role === "user") totalPrompts++;
      totalTokens += e.total_tokens || 0;
    }
  }
  // naive cost estimate (adjust as needed)
  const estCost = (totalTokens / 1000) * 0.005; // £0.005 per 1K tokens (example)
  res.json({
    sessions: sessions?.length || 0,
    submitted: (sessions || []).filter((s) => s.submitted).length,
    totalPrompts,
    totalTokens,
    estCost,
  });
});

// Seed demo assignment (dev)
app.post("/api/assignment/seed", async (_req, res) => {
  try {
    const id = uuidv4();
    const a = {
      id,
      module_code: "BIO1001",
      title: "Demo Coursework",
      prompt_cap: 100,
      output_token_cap: 500,
      input_token_cap: 1000,
      mode: "amber",
      due_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      model: "gpt-4o-mini",
      prompt_templates: [
        {
          label: "Plan my methods section",
          text: "Help me outline the key steps for the methods section focusing on PCR and gel electrophoresis.",
        },
      ],
    };
    const { data, error } = await supa
      .from("assignments")
      .insert(a)
      .select("id")
      .single();
    if (error)
      return res
        .status(500)
        .json({ error: "Insert failed", detail: error.message });
    res.json({ id: data.id });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

// Catch-all
app.get("*", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html")),
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Worksy running on ${PORT}`));
