import { exportCsv } from "../export/csv.ts";
import { buildExport, exportJson, type ExportSnapshot } from "../export/document.ts";
import { element } from "./controls.ts";

function download(name: string, type: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = element("a", { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const fileStem = (snapshot: ExportSnapshot) => {
  const host = new URL(snapshot.app.uiOrigin).host.replace(/[^a-zA-Z0-9.-]/g, "_");
  const stamp = new Date(snapshot.exportedAtWallMs).toISOString().replace(/[:.]/g, "-");
  return `blip-${host}-${stamp}`;
};

export function buildExportPanel(root: HTMLElement, snapshot: () => ExportSnapshot): void {
  const both = element("button", { type: "button", id: "export", textContent: "Export JSON and CSV" });
  both.addEventListener("click", () => {
    const taken = snapshot();
    const document = buildExport(taken);
    download(`${fileStem(taken)}.json`, "application/json", exportJson(document));
    download(`${fileStem(taken)}.csv`, "text/csv", exportCsv(document));
  });
  root.append(
    element("h2", { textContent: "Export" }),
    element("p", {
      className: "note",
      textContent:
        "Exports are created in this browser and saved to your device; nothing is uploaded. Both files come from the same moment and contain every retained request and unsent slot, markers, the baseline, the settings in effect, and the summary currently displayed. Run node scripts/summarize-export.ts on them to recompute the summary.",
    }),
    element("div", { className: "buttons" }, [both]),
  );
}
