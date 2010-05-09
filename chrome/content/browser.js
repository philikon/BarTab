Components.utils.import("resource://bartap/prototypes.js");

// Initialize BarTab as soon as possible.
window.addEventListener("DOMContentLoaded", function() {
    window.removeEventListener("DOMContentLoaded", arguments.callee, false);
    var tabbrowser = document.getElementById("content");
    (new BarTabHandler).init(tabbrowser);
}, false);
