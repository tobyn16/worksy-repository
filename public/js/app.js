// Elements
const d = document;
const logEl = d.getElementById("log");
const typingEl = d.getElementById("typing");
const usageEl = d.getElementById("usage");
const modePill = d.getElementById("modePill");
const duePill = d.getElementById("duePill");
const wc = d.getElementById("wc");
const studentEl = d.getElementById("student");
const assignmentEl = d.getElementById("assignmentId");
const consentChk = d.getElementById("consentChk");
const msgEl = d.getElementById("msg");
const notesEl = d.getElementById("notes");

const themeToggle = d.getElementById("themeToggle");
const fontUp = d.getElementById("fontUp");
const fontDown = d.getElementById("fontDown");
const clearBtn = d.getElementById("clearBtn");

const loadPolicyBtn = d.getElementById("loadPolicyBtn");
const sendBtn = d.getElementById("sendBtn");
const indexBtn = d.getElementById("indexBtn");
const submitBtn = d.getElementById("submitBtn");
const saveCloudBtn = d.getElementById("saveCloudBtn");
const dlJsonBtn = d.getElementById("dlJsonBtn");
const dlPdfBtn = d.getElementById("dlPdfBtn");

let sessionId = null;
let promptsUsed = 0;
let promptCap = 100;
let lastIndexJson = null;
let lastVerifyUrl = null;

// Toast
function toast(t) {
  const el = d.getElementById("toast");
  el.textContent = t;
  el.style.display = "block";
  setTimeout(() => (el.style.display = "none"), 2200);
}
function nowHM() {
  return new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Theme + font
const root = document.documentElement;
(function initTheme() {
  const t = localStorage.getItem("worksy_theme") || "dark";
  d.documentElement.setAttribute("data-theme", t);
})();
themeToggle.addEventListener("click", () => {
  const cur =
    d.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
  d.documentElement.setAttribute("data-theme", cur);
  localStorage.setItem("worksy_theme", cur);
});
let fontScale = Number(localStorage.getItem("worksy_font") || 1);
function applyFont() {
  d.body.style.fontSize = fontScale * 1.0 + "rem";
}
applyFont();
fontUp.addEventListener("click", () => {
  fontScale = Math.min(1.4, fontScale + 0.05);
  localStorage.setItem("worksy_font", fontScale);
  applyFont();
});
fontDown.addEventListener("click", () => {
  fontScale = Math.max(0.85, fontScale - 0.05);
  localStorage.setItem("worksy_font", fontScale);
  applyFont();
});

// Utilities
function copyText(t) {
  navigator.clipboard.writeText(t).then(() => toast("Copied"));
}
function addCopyButton(el, text) {
  const btn = d.createElement("button");
  btn.textContent = "Copy";
  btn.className = "copy";
  btn.onclick = () => copyText(text);
  el.appendChild(btn);
}
function addBubble(who, text) {
  const wrap = d.createElement("div");
  wrap.className = "bubble " + (who === "You" ? "me" : "ai");
  const body = d.createElement("div");
  body.innerHTML = (text || "").replace(/\n/g, "<br>");
  const meta = d.createElement("div");
  meta.className = "meta";
  meta.textContent = `${who} • ${nowHM()}`;
  wrap.appendChild(body);
  wrap.appendChild(meta);
  addCopyButton(wrap, text || "");
  logEl.appendChild(wrap);
  logEl.scrollTop = logEl.scrollHeight;
}
function updateUsage() {
  usageEl.textContent = `Prompts used: ${promptsUsed} / ${promptCap}`;
}
function resetSessionUI() {
  sessionId = null;
  promptsUsed = 0;
  updateUsage();
  sendBtn.disabled = false;
  msgEl.disabled = false;
  notesEl.disabled = false;
  typingEl.style.display = "none";
  logEl.innerHTML = "";
}

// Persist small fields
studentEl.value = localStorage.getItem("worksy_student") || "";
assignmentEl.value = localStorage.getItem("worksy_assignment") || "";
studentEl.addEventListener("blur", () =>
  localStorage.setItem("worksy_student", studentEl.value.trim()),
);
assignmentEl.addEventListener("blur", () =>
  localStorage.setItem("worksy_assignment", assignmentEl.value.trim()),
);

// Word counter + hard cap (100 words)
function countWords(t) {
  return (t.trim().match(/\S+/g) || []).length;
}
msgEl.addEventListener("input", () => {
  const w = countWords(msgEl.value);
  wc.textContent = `(${w} / 100 words)`;
  wc.style.color = w > 100 ? "#ff8894" : "";
});

// Clear view
clearBtn.addEventListener("click", () => {
  logEl.innerHTML = "";
  toast("Cleared chat view");
});

// Load policy
async function loadPolicy() {
  const id = assignmentEl.value.trim();
  if (!id) return toast("Paste the Assignment ID first");
  let res, data;
  try {
    res = await fetch("/api/policy?assignmentId=" + encodeURIComponent(id));
    data = await res.json();
  } catch {
    toast("Network error fetching policy");
    return;
  }

  const box = d.getElementById("policyBox");
  const remind = d.getElementById("policyReminder");
  const allowed = d.getElementById("allowedList");
  const notList = d.getElementById("notList");
  const caps = d.getElementById("capsLine");

  if (!res.ok) {
    if (box) box.style.display = "block";
    if (remind) remind.textContent = data?.error || "Assignment not found.";
    if (allowed) allowed.textContent = "";
    if (notList) notList.textContent = "";
    if (caps) caps.textContent = "";
    return;
  }

  if (remind) remind.textContent = data.reminder || "";
  if (allowed) allowed.textContent = (data.allowed || []).join("; ");
  if (notList) notList.textContent = (data.notAllowed || []).join("; ");
  if (caps)
    caps.textContent = `Module: ${data.module?.code ?? "N/A"} — ${data.module?.title ?? ""} • Prompt cap: ${data.caps?.prompt_cap} • Response cap: ${data.caps?.output_token_cap} tokens.`;
  if (box) box.style.display = "block";

  promptCap = data.caps?.prompt_cap ?? 100;
  updateUsage();
  modePill.textContent = "Mode: " + String(data.mode || "amber").toUpperCase();
  duePill.textContent =
    "Due: " +
    (data.due_at ? new Date(data.due_at).toLocaleString("en-GB") : "—");

  resetSessionUI();
}

// Consent + notes
async function maybeSaveNotes() {
  if (!sessionId) return;
  const notes = notesEl.value.trim();
  if (!notes) return;
  await fetch("/api/session/notes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, notes }),
  });
}
async function ensureConsent() {
  if (!sessionId) return false;
  if (!consentChk?.checked) return false;
  await fetch("/api/session/consent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  return true;
}

// Send
async function send() {
  const studentRef = studentEl.value.trim();
  const assignmentId = assignmentEl.value.trim();
  const message = msgEl.value.trim();
  const wordCount = countWords(message);
  if (!studentRef || !assignmentId || !message) {
    toast("Fill student, assignment ID, and a message");
    return;
  }
  if (wordCount > 100) {
    toast("Please keep your question ≤ 100 words");
    return;
  }
  if (!consentChk?.checked) {
    toast("Tick the consent box first");
    return;
  }
  if (sendBtn.disabled) return;

  sendBtn.disabled = true;
  try {
    addBubble("You", message);
    msgEl.value = "";
    wc.textContent = "(0 / 100 words)";
    typingEl.style.display = "block";

    let res, data;
    try {
      res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId,
          assignmentId,
          studentRef,
          message,
          locale: "en-GB",
        }),
      });
      data = await res.json();
    } catch {
      addBubble(
        "System",
        '<span style="color:#ff8894">Network error. Try again.</span>',
      );
      return;
    }

    if (!res.ok) {
      typingEl.style.display = "none";
      addBubble(
        "System",
        `<span style="color:#ff8894">${data.error || "Error"}</span>`,
      );
      return;
    }

    sessionId = data.sessionId || sessionId;
    await ensureConsent();
    await maybeSaveNotes();
    promptsUsed = data.promptsUsed ?? promptsUsed;
    promptCap = data.promptCap ?? promptCap;

    await streamReveal("Worksy", data.reply);
    updateUsage();
  } finally {
    typingEl.style.display = "none";
    sendBtn.disabled = false;
  }
}
// Faux token-by-token reveal (smooth)
async function streamReveal(who, text) {
  const wrap = d.createElement("div");
  wrap.className = "bubble " + (who === "You" ? "me" : "ai");
  const body = d.createElement("div");
  body.textContent = "";
  const meta = d.createElement("div");
  meta.className = "meta";
  meta.textContent = `${who} • ${nowHM()}`;
  wrap.appendChild(body);
  wrap.appendChild(meta);
  addCopyButton(wrap, text || "");
  logEl.appendChild(wrap);
  logEl.scrollTop = logEl.scrollHeight;
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    body.textContent += chars[i];
    if (i % 5 === 0) await new Promise((r) => setTimeout(r, 5));
  }
  body.innerHTML = body.textContent.replace(/\n/g, "<br>");
}

// Index generation
async function genIndex() {
  if (!sessionId) return toast("Send at least one message first");
  await maybeSaveNotes();
  const r = await fetch("/api/index/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  const j = await r.json();
  if (!r.ok) {
    addBubble(
      "System",
      `<span style="color:#ff8894">${j.error || "Error"}</span>`,
    );
    return;
  }
  addBubble(
    "System",
    `<span style="color:#29d39a">AI Index generated. Hash: ${j.hash}</span>`,
  );
  lastIndexJson = j.index;
  lastIndexJson.hash = j.hash;
  lastIndexJson.hmac = j.hmac;
  lastVerifyUrl = `${location.origin}/api/index/verify?id=${j.id}`;
}

// Submit & lock
async function submitAndLock() {
  if (!sessionId) return toast("No active session");
  const r = await fetch("/api/submit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  const j = await r.json();
  if (j.ok || j.alreadySubmitted) {
    addBubble(
      "System",
      `<span style="color:#29d39a">Submitted & locked. Further prompts disabled.</span>`,
    );
    sendBtn.disabled = true;
    msgEl.disabled = true;
    notesEl.disabled = true;
  } else
    addBubble(
      "System",
      `<span style="color:#ff8894">${j.error || "Submission error"}</span>`,
    );
}

// Save to Storage
async function saveToCloud() {
  if (!sessionId) return toast("No active session");
  const r = await fetch("/api/index/upload", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  const j = await r.json();
  if (j.url) {
    addBubble(
      "System",
      `Saved to Uni storage. <a href="${j.url}" target="_blank" style="color:#c6d2ff">Open link</a>`,
    );
    toast("Saved");
  } else
    addBubble(
      "System",
      `<span style="color:#ff8894">${j.error || "Upload failed"}</span>`,
    );
}

// Downloads
function downloadJson(filename, obj) {
  if (!obj) return toast("Generate the AI Index first");
  const blob = new Blob([JSON.stringify(obj, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = d.createElement("a");
  a.href = url;
  a.download = filename;
  d.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
async function downloadPdf(filename, obj) {
  const { jsPDF } = window.jspdf || {};
  if (!jsPDF) return toast("PDF lib not loaded");
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  const Hh = doc.internal.pageSize.getHeight();
  const m = 40;
  let y = m;
  const H = (t) => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.text(t, m, y);
    y += 18;
  };
  const P = (t) => {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    doc.splitTextToSize(t, W - m * 2).forEach((line) => {
      doc.text(line, m, y);
      y += 14;
    });
    y += 2;
    if (y > Hh - 60) {
      doc.text(`Page ${doc.getNumberOfPages()}`, W - m, Hh - 20, {
        align: "right",
      });
      doc.addPage();
      y = m;
    }
  };

  H("Worksy — AI Index");
  P(
    `Generated: ${new Date().toLocaleString("en-GB")} • Hash: ${obj.hash || "(see DB)"} • HMAC: ${obj.hmac ? obj.hmac.slice(0, 10) + "…" : "(n/a)"}`,
  );
  P(`Module: ${obj.assignment.module} — ${obj.assignment.title}`);
  P(`Student: ${obj.student}`);
  P(
    `Caps: prompts=${obj.caps.prompt_cap}, input tokens≈${obj.caps.input_token_cap}, response tokens=${obj.caps.output_token_cap}`,
  );
  P(
    `Session: started=${obj.session.started_at}, tab switches=${obj.session.tab_switches}`,
  );
  if (obj.session.notes) P(`Student notes: ${obj.session.notes}`);
  P(
    `Policy version: ${obj.policy_version} • Config version: ${obj.config_version}`,
  );
  if (lastVerifyUrl) {
    const div = d.createElement("div");
    new QRCode(div, { text: lastVerifyUrl, width: 96, height: 96 });
    const img = div.querySelector("img");
    if (img) doc.addImage(img.src, "PNG", W - m - 96, m, 96, 96);
  }
  y += 6;
  H("Transcript");
  (obj.events || []).forEach((e) => {
    P(
      `${e.role === "user" ? "You" : "Worksy"} @ ${e.created_at}\n${e.content}`,
    );
  });
  doc.text(`Page ${doc.getNumberOfPages()}`, W - m, Hh - 20, {
    align: "right",
  });
  doc.save(filename);
}

// Tab switch audit
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && sessionId) {
    fetch("/api/tab-switch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
  }
});

// Bindings
document.addEventListener("DOMContentLoaded", () => {
  loadPolicyBtn.addEventListener("click", loadPolicy);
  sendBtn.addEventListener("click", send);
  indexBtn.addEventListener("click", genIndex);
  submitBtn.addEventListener("click", submitAndLock);
  saveCloudBtn.addEventListener("click", saveToCloud);
  dlJsonBtn.addEventListener("click", () => {
    if (!lastIndexJson) return toast("Generate the AI Index first");
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    downloadJson(`worksy-ai-index-${ts}.json`, lastIndexJson);
  });
  dlPdfBtn.addEventListener("click", () => {
    if (!lastIndexJson) return toast("Generate the AI Index first");
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    downloadPdf(`worksy-ai-index-${ts}.pdf`, lastIndexJson);
  });
});
