Components.utils.import("resource://bartab/prototypes.js");

// Initialize BarTab as soon as possible.
window.addEventListener("DOMContentLoaded", function() {
    window.removeEventListener("DOMContentLoaded", arguments.callee, false);
    BarTabUtils.migratePrefs();
    var tabbrowser = document.getElementById("content");
    (new BarTabHandler).init(tabbrowser);
}, false);
