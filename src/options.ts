import { DEFAULT_SETTINGS, loadSettings, type Settings } from "./shared";

const form = document.querySelector<HTMLFormElement>("#settings")!;
const saved = document.querySelector<HTMLElement>("#saved")!;

function field<T extends HTMLInputElement>(name: keyof Settings): T {
  return form.elements.namedItem(name) as T;
}

async function fill(): Promise<void> {
  const settings = await loadSettings();
  field("apiKey").value = settings.apiKey;
  field("transcribeModel").value = settings.transcribeModel;
  field("draftModel").value = settings.draftModel;
  field("translateModel").value = settings.translateModel;
  field("summaryModel").value = settings.summaryModel;
  field("showEnglish").checked = settings.showEnglish;
  field("showLiveEnglish").checked = settings.showLiveEnglish;
  field("showOverlay").checked = settings.showOverlay;
  field("fontSize").value = String(settings.fontSize);
  field("maxSegmentSeconds").value = String(settings.maxSegmentSeconds);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const settings: Settings = {
    apiKey: field("apiKey").value.trim(),
    transcribeModel: field("transcribeModel").value.trim() || DEFAULT_SETTINGS.transcribeModel,
    draftModel: field("draftModel").value.trim() || DEFAULT_SETTINGS.draftModel,
    translateModel: field("translateModel").value.trim() || DEFAULT_SETTINGS.translateModel,
    summaryModel: field("summaryModel").value.trim() || DEFAULT_SETTINGS.summaryModel,
    showEnglish: field("showEnglish").checked,
    showLiveEnglish: field("showLiveEnglish").checked,
    showOverlay: field("showOverlay").checked,
    fontSize: Number(field("fontSize").value) || DEFAULT_SETTINGS.fontSize,
    maxSegmentSeconds: Number(field("maxSegmentSeconds").value) || DEFAULT_SETTINGS.maxSegmentSeconds,
  };
  await chrome.storage.local.set(settings);
  saved.textContent = "保存しました";
  setTimeout(() => (saved.textContent = ""), 2000);
});

document.querySelector("#reset-models")!.addEventListener("click", () => {
  field("transcribeModel").value = DEFAULT_SETTINGS.transcribeModel;
  field("draftModel").value = DEFAULT_SETTINGS.draftModel;
  field("translateModel").value = DEFAULT_SETTINGS.translateModel;
  field("summaryModel").value = DEFAULT_SETTINGS.summaryModel;
  saved.textContent = "入力欄に反映しました。「保存」を押すと確定します。";
});

void fill();
