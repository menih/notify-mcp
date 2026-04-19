// Tab switching
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const target = tab.dataset.tab;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("tab-active", t === tab));
    document.querySelectorAll(".tab-panel").forEach((p) =>
      p.classList.toggle("tab-panel-active", p.dataset.panel === target)
    );
  });
});

// Copy buttons
document.querySelectorAll(".copy-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const text = btn.dataset.copy;
    try {
      await navigator.clipboard.writeText(text);
      const orig = btn.textContent;
      btn.textContent = "Copied!";
      btn.classList.add("copied");
      setTimeout(() => {
        btn.textContent = orig;
        btn.classList.remove("copied");
      }, 1500);
    } catch (err) {
      btn.textContent = "Failed";
      setTimeout(() => (btn.textContent = "Copy"), 1500);
    }
  });
});
