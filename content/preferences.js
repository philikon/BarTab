Components.utils.import("resource://bartab/prototypes.js");

var BarTabPreferences = {

  init: function() {
    BarTabUtils.mPrefs.addObserver("extensions.bartab.whitelist", this, false);
    this.onTimeoutChange();
    this.updateWhitelist();
  },

  destroy: function() {
    BarTabUtils.mPrefs.removeObserver("extensions.bartab.whitelist", this);
  },

  QueryInterface: function(aIID) {
    if (aIID.equals(Components.interfaces.nsIObserver) ||
        aIID.equals(Components.interfaces.nsISupports)) {
      return this;
    }
    throw Components.results.NS_ERROR_NO_INTERFACE;
  },


  // Toggle visibility for timeout and load delay settings.

  onTimeoutChange: function() {
    var menuitem = document.getElementById('tapAfterTimeout').selectedItem;
    var timerWidgets = document.getElementById('timerWidgets');
    var visibility = (menuitem.value == "true") ? 'visible' : 'hidden';
    timerWidgets.style.visibility = visibility;
  },

  // Add to and remove entries from whitelist

  updateWhitelist: function() {
    var list = document.getElementById("whitelist");
    while (list.firstChild) {
      list.removeChild(list.firstChild);
    }

    var whitelist = BarTabUtils.getWhitelist();
    whitelist.forEach(function(entry) {
        let row = document.createElement("listitem");
        row.setAttribute("label", entry);
        list.appendChild(row);
      });
  },

  whiteListEntrySelected: function() {
    var removeButton = document.getElementById("whitelistRemove");
    var list = document.getElementById("whitelist");
    if (list.selectedItems.length) {
      removeButton.setAttribute("disabled", "false");
    } else {
      removeButton.setAttribute("disabled", "true");
    }
  },

  removeWhitelistEntry: function() {
    var list = document.getElementById("whitelist");
    var whitelist = BarTabUtils.getWhitelist();
    var self = this;
    list.selectedItems.forEach(function (item) {
        var entry = item.getAttribute("label");
        var index = whitelist.indexOf(entry);
        if (index == -1) {
            return;
        }
        whitelist.splice(index, 1);
    });
    BarTabUtils.setWhitelist(whitelist);
  },

  observe: function(aSubject, aTopic, aData) {
    if (aTopic != "nsPref:changed") {
      return;
    }
    this.updateWhitelist();
  }

};
