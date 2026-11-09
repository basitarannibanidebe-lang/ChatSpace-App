// Blocks the easy ways to open browser Inspect / developer tools.
// This only stops casual use. A browser can always be opened some other way,
// so real protection must stay in Supabase rules (RLS) and the Worker.
(() => {
  const editable = (t) =>
    /^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName || "") || t?.isContentEditable;
  document.addEventListener("contextmenu", (e) => {
    if (!editable(e.target)) e.preventDefault();
  });
  document.addEventListener(
    "keydown",
    (e) => {
      const k = (e.key || "").toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      const blocked =
        e.key === "F12" ||
        (mod && e.shiftKey && ["i", "j", "c", "k"].includes(k)) ||
        (e.metaKey && e.altKey && ["i", "j", "c", "u"].includes(k)) ||
        (mod && !e.shiftKey && !e.altKey && k === "u");
      if (blocked) e.preventDefault();
    },
    true,
  );
})();
