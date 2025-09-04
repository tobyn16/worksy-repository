const { jsPDF } = window.jspdf || {};
const statusEl = document.getElementById("status");

function setStatus(text, cls = "ok") {
  statusEl.textContent = text;
  statusEl.className = "";
  statusEl.classList.add(cls);
  statusEl.style.display = "block";
}

const adminKeyEl = document.getElementById("adminKey");
const assignmentSel = document.getElementById("assignmentSel");
const studentFilterEl = document.getElementById("studentFilter");
const fromEl = document.getElementById("from");
const toEl = document.getElementById("to");
const lockedOnlyEl = document.getElementById("lockedOnly");
const highTabsEl = document.getElementById("highTabs");
const loadBtn = document.getElementById("loadBtn");
const exportBtn = document.getElementById("exportBtn");
const pdfBtn = document.getElementById("pdfBtn");
const testKeyBtn = document.getElementById("testKeyBtn");
const csvEl = document.getElementById("csv");
const importBtn = document.getElementById("importBtn");
const tbody = document.querySelector("#sessionTable tbody");
const eventsEl = document.getElementById("events");

adminKeyEl.value = localStorage.getItem("worksy_admin_key") || "";
adminKeyEl.addEventListener("blur", () =>
  localStorage.setItem("worksy_admin_key", adminKeyEl.value.trim()),
);

async function fetchJSON(url) {
  const r = await fetch(url, {
    headers: { "x-admin-key": adminKeyEl.value.trim() },
  });
  if (r.status === 401) {
    throw new Error("UNAUTHORIZED");
  }
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`HTTP ${r.status}: ${t}`);
  }
  return r.json();
}
async function postJSON(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-admin-key": adminKeyEl.value.trim(),
    },
    body: JSON.stringify(body),
  });
  if (r.status === 401) throw new Error("UNAUTHORIZED");
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`HTTP ${r.status}: ${t}`);
  }
  return r.json();
}

async function loadAssignments() {
  try {
    const d = await fetchJSON("/api/admin/assignments");
    const list = d.assignments || [];
    if (!list.length) {
      assignmentSel.innerHTML = "";
      setStatus(
        "No assignments found. Click “Seed demo assignment” or create one from the main page.",
        "warn",
      );
      return;
    }
    assignmentSel.innerHTML = list
      .map(
        (a) =>
          `<option value="${a.id}">${a.module_code || "N/A"} — ${a.title} (${(a.mode || "amber").toUpperCase()})</option>`,
      )
      .join("");
    setStatus(`Loaded ${list.length} assignment(s).`, "ok");
  } catch (e) {
    if (e.message === "UNAUTHORIZED")
      setStatus(
        "Admin key rejected (401). Make sure Replit Secret ADMIN_KEY matches exactly, then Stop → Run the server.",
        "err",
      );
    else setStatus("Failed to load assignments: " + e.message, "err");
    throw e;
  }
}

function qs(o) {
  const p = new URLSearchParams();
  Object.entries(o).forEach(([k, v]) => {
    if (v !== undefined && v !== "") p.set(k, v);
  });
  return p.toString();
}

async function loadSessions() {
  try {
    const q = qs({
      assignmentId: assignmentSel.value,
      studentRef: studentFilterEl.value.trim(),
      from: fromEl.value ? new Date(fromEl.value).toISOString() : "",
      to: toEl.value ? new Date(toEl.value).toISOString() : "",
      lockedOnly: lockedOnlyEl.checked ? "true" : "",
      highTabs: highTabsEl.checked ? "true" : "",
    });
    const d = await fetchJSON("/api/admin/sessions?" + q);
    const rows = d.sessions || [];
    tbody.innerHTML = rows.length
      ? rows
          .map(
            (s) => `
      <tr data-id="${s.id}" data-index="${s.index_id || ""}">
        <td><a href="#" class="slink">${s.id}</a></td>
        <td>${s.student_ref || ""}</td>
        <td>${s.started_at || ""}</td>
        <td>${s.submitted ? "Yes" : "No"}</td>
        <td>${s.submitted_at || ""}</td>
        <td>${s.tab_switches || 0}</td>
        <td>${(s.risk_score || 0) >= 0.8 ? '<span class="pill riskHi">Review</span>' : ""}</td>
        <td class="fp">—</td>
      </tr>`,
          )
          .join("")
      : '<tr><td colspan="8">No sessions yet</td></tr>';
    eventsEl.innerHTML = "";
    pdfBtn.disabled = true;
    setStatus(`Loaded ${rows.length} session(s).`, "ok");

    // Fetch fingerprint statuses
    for (const tr of tbody.querySelectorAll("tr[data-index]")) {
      const idx = tr.getAttribute("data-index");
      if (!idx) {
        tr.querySelector(".fp").textContent = "No index";
        continue;
      }
      try {
        const v = await fetchJSON(
          "/api/index/verify?id=" + encodeURIComponent(idx),
        );
        tr.querySelector(".fp").textContent =
          v.hashOK && v.hmacOK ? "OK" : "Mismatch";
        tr.querySelector(".fp").style.color =
          v.hashOK && v.hmacOK ? "#9af0b6" : "#ff8ea0";
      } catch {
        tr.querySelector(".fp").textContent = "Check failed";
        tr.querySelector(".fp").style.color = "#ffb48d";
      }
    }
  } catch (e) {
    if (e.message === "UNAUTHORIZED")
      setStatus(
        "Admin key rejected (401). Re-enter the key and press Load.",
        "err",
      );
    else setStatus("Failed to load sessions: " + e.message, "err");
  }
}

async function loadEvents(sessionId) {
  try {
    const d = await fetchJSON("/api/admin/sessions/" + sessionId + "/events");
    eventsEl.innerHTML =
      "<h3>Transcript</h3>" +
      (d.events || [])
        .map(
          (e) => `
      <div class="bubble">
        <div class="meta"><b>${e.role === "user" ? "Student" : "Worksy"}</b> • ${e.created_at} • ${e.model || ""} ${e.total_tokens ? "• tokens:" + e.total_tokens : ""}</div>
        <div>${(e.content || "").replace(/\n/g, "<br>")}</div>
      </div>`,
        )
        .join("") +
      (d.fingerprint
        ? `<div class="meta">Fingerprint: hashOK=${d.fingerprint.hashOK}, hmacOK=${d.fingerprint.hmacOK} • ${d.fingerprint.hash.slice(0, 10)}…</div>`
        : "");
    pdfBtn.disabled = !(d.events || []).length;
    pdfBtn.dataset.sessionId = sessionId;
    setStatus(`Loaded ${d.events?.length || 0} events.`, "ok");
  } catch (e) {
    if (e.message === "UNAUTHORIZED")
      setStatus("Admin key rejected (401).", "err");
    else setStatus("Failed to load events: " + e.message, "err");
  }
}

loadBtn.onclick = async () => {
  await loadAssignments();
  if (assignmentSel.value) await loadSessions();
};

exportBtn.onclick = async () => {
  try {
    const aId = assignmentSel.value;
    if (!aId) return setStatus("Select an assignment first", "warn");
    const r = await fetch(
      "/api/admin/export?assignmentId=" + encodeURIComponent(aId),
      { headers: { "x-admin-key": adminKeyEl.value.trim() } },
    );
    if (r.status === 401) throw new Error("UNAUTHORIZED");
    if (!r.ok) throw new Error("HTTP " + r.status);
    const b = await r.blob();
    const url = URL.createObjectURL(b);
    const a = document.createElement("a");
    a.href = url;
    a.download = "worksy-sessions.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setStatus("CSV exported.", "ok");
  } catch (e) {
    if (e.message === "UNAUTHORIZED")
      setStatus("Admin key rejected (401) when exporting.", "err");
    else setStatus("Export failed: " + e.message, "err");
  }
};

document.addEventListener("click", (e) => {
  const a = e.target.closest(".slink");
  if (!a) return;
  e.preventDefault();
  const id = a.closest("tr").dataset.id;
  loadEvents(id);
});

pdfBtn.onclick = () => {
  if (!window.jspdf) return setStatus("PDF library not loaded", "err");
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
  H("Worksy — Session Transcript");
  const rows = Array.from(document.querySelectorAll("#sessionTable tbody tr"));
  const sel = rows.find((r) => r.dataset.id === pdfBtn.dataset.sessionId);
  if (sel) {
    const tds = sel.querySelectorAll("td");
    P(`Session: ${tds[0].innerText}`);
    P(`Student: ${tds[1].innerText}`);
    P(`Started: ${tds[2].innerText}`);
    P(`Submitted: ${tds[3].innerText} • At: ${tds[4].innerText}`);
    P(`Tab switches: ${tds[5].innerText}`);
  }
  H("Transcript");
  const bubbles = Array.from(eventsEl.querySelectorAll(".bubble"));
  bubbles.forEach((b) => {
    P(b.innerText);
  });
  doc.text(`Page ${doc.getNumberOfPages()}`, W - m, Hh - 20, {
    align: "right",
  });
  doc.save("worksy-transcript.pdf");
};

testKeyBtn.onclick = async () => {
  try {
    await loadAssignments();
  } catch {}
};

importBtn.onclick = async () => {
  try {
    const csv = (csvEl.value || "").trim();
    if (!csv) return setStatus("Paste CSV first", "warn");
    const [headerLine, ...lines] = csv.split(/\r?\n/).filter(Boolean);
    const headers = headerLine.split(",").map((h) => h.trim());
    const rows = lines.map((line) => {
      const cols = line.split(",");
      const obj = {};
      headers.forEach((h, i) => (obj[h] = cols[i] ?? ""));
      return obj;
    });
    const j = await postJSON("/api/admin/assignments/import", { rows });
    setStatus(`Imported ${j.count} assignment(s). Click Load.`, "ok");
  } catch (e) {
    setStatus("Import failed: " + e.message, "err");
  }
};

// Auto-hint
setStatus("Enter ADMIN_KEY → Test key → Load. Seed a demo if empty.", "warn");
