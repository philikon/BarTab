Components.utils.import("resource://bartap/prototypes.js");

function BarTabHandler() {}
BarTabHandler.prototype = {

  /*
   * Initialize the tab browser.  This is deliberately its own method
   * so that extensions that have other tabbrowsers can call it.
   */
  init: function(aTabBrowser) {
    aTabBrowser.BarTabHandler = this;
    this.tabbrowser = aTabBrowser;

    let document = aTabBrowser.ownerDocument;
    this.l10n = document.getElementById('bartap-strings');

    aTabBrowser.tabContainer.addEventListener('SSTabRestoring', this, false);
    aTabBrowser.tabContainer.addEventListener('TabOpen', this, false);
    aTabBrowser.tabContainer.addEventListener('TabSelect', this, false);
    aTabBrowser.tabContainer.addEventListener('TabClose', this, false);

    // Initialize timer
    this.timer = new BarTabTimer(aTabBrowser);

    // We need an event listener for the context menu so that we can
    // adjust the label of the whitelist menu item
    let popup = aTabBrowser.tabContainer.contextMenu;
    if (!popup) {
      // In Firefox <3.7, the tab context menu lives inside the tabbrowser.
      popup = document.getAnonymousElementByAttribute(
          aTabBrowser, "anonid", "tabContextMenu");
      let before = document.getAnonymousElementByAttribute(
          aTabBrowser, "id", "context_openTabInWindow");
      for each (let menuitemid in ["context_BarTabUnloadTab",
                                   "context_BarTabUnloadOtherTabs",
                                   "context_BarTabNeverUnload",
                                   "context_BarTabSeparator"]) {
        let menuitem = document.getElementById(menuitemid);
        popup.insertBefore(menuitem, before);
      }
    }
    popup.addEventListener('popupshowing', this, false);
  },


  /*** Event handlers ***/

  handleEvent: function(aEvent) {
    switch (aEvent.type) {
    case 'SSTabRestoring':
      this.onTabRestoring(aEvent);
      return;
    case 'TabOpen':
      this.onTabOpen(aEvent);
      return;
    case 'TabSelect':
      this.onTabSelect(aEvent);
      return;
    case 'TabClose':
      this.onTabClose(aEvent);
      return;
    case 'popupshowing':
      this.onPopupShowing(aEvent);
      return;
    }
  },

  /*
   * Hook into newly opened tabs if the user wants to prevent tabs
   * opened in the background from loading.  (If this tab ends up not
   * being in the background after all, 'onTabSelect' will take care
   * of loading the tab.)
   */
  onTabOpen: function(aEvent) {
    var tab = aEvent.originalTarget;
    if (!tab.selected
        && BarTabUtils.mPrefs.getBoolPref("extensions.bartap.tapBackgroundTabs")) {
      tab.setAttribute("ontap", "true");
      (new BarTabWebNavigation()).hook(tab);
    } else if (BarTabUtils.mPrefs.getBoolPref("extensions.bartap.tapAfterTimeout")) {
      this.timer.startTimer(tab);
    }
  },

  /*
   * Listen to the 'SSTabRestoring' event from the nsISessionStore
   * service and hook into restored tabs if the user wants to prevent
   * restored tabs from loading.
   */
  onTabRestoring: function(aEvent) {
    if (!BarTabUtils.mPrefs.getBoolPref("extensions.bartap.tapRestoredTabs")) {
      return;
    }
    let tab = aEvent.originalTarget;
    if (tab.selected || tab.getAttribute("ontap") == "true") {
      return;
    }
    tab.setAttribute("ontap", "true");
    (new BarTabWebNavigation()).hook(tab);
  },

  onTabSelect: function(aEvent) {
    var tab = aEvent.originalTarget;
    if (tab.getAttribute("ontap") != "true") {
      return;
    }

    // Always load a blank page immediately
    let uri = tab.linkedBrowser.webNavigation.currentURI;
    if (!uri || (uri.spec == "about:blank")) {
      this.loadTab(tab);
      return;      
    }

    let self = this;

    switch (BarTabUtils.mPrefs.getIntPref("extensions.bartap.loadOnSelect")) {
    case 1:
      // Load immediately
      this.loadTab(tab);
      return;
    case 2:
      // Load after delay
      let delay = BarTabUtils.mPrefs.getIntPref("extensions.bartap.loadOnSelectDelay");
      window.setTimeout(function() {
          if (tab.selected) {
            self.loadTab(tab);
          }
        }, delay);
      return;
    case 0:
      // Ask whether to load
      let box = this.tabbrowser.getNotificationBox(tab.linkedBrowser);
      let label = this.l10n.getString("loadNotification");
      let buttons = [{label: this.l10n.getString("loadButton"),
                      accessKey: this.l10n.getString("loadButton.accesskey"),
                      callback: function() {self.loadTab(tab);}}];
      let bar = box.appendNotification(label, 'bartap-load', "",
                                       box.PRIORITY_INFO_MEDIUM, buttons);
      return;
    }
  },

  onTabClose: function(aEvent) {
    if (!BarTabUtils.mPrefs.getBoolPref("extensions.bartap.findClosestUntappedTab")) {
      return;
    }
    let tab = aEvent.originalTarget;
    if (!tab.selected) {
      return;
    }
    let activeTab = this.findClosestLoadedTab(tab);
    if (activeTab) {
      this.tabbrowser.selectedTab = activeTab;
    }
  },

  onPopupShowing: function(aEvent) {
    var tab =  document.popupNode.localName == "tab" ?
          document.popupNode : gBrowser.selectedTab;

    var neverunload = document.getElementById("context_BarTabNeverUnload");
    var unloadtab = document.getElementById("context_BarTabUnloadTab");

    let host;
    try {
      host = tab.linkedBrowser.currentURI.host;
    } catch (ex) {
      // Most likely uri.host doesn't exist which probably means whitelisting
      // doesn't make sense on this tab.  Don't show the menu item
      neverunload.setAttribute("hidden", "true");
      unloadtab.removeAttribute("disabled");
      return;
    }

    let label = this.l10n.getFormattedString('neverPutOnTap', [host]);
    neverunload.setAttribute("label", label);
    neverunload.removeAttribute("hidden");
    if (BarTabUtils.whiteListed(tab.linkedBrowser.currentURI)) {
      neverunload.setAttribute("checked", "true");
      unloadtab.setAttribute("disabled", "true");
      return;
    }

    neverunload.removeAttribute("checked");
    if (tab.getAttribute("ontap") == "true") {
      unloadtab.setAttribute("disabled", "true");
    } else {
      unloadtab.removeAttribute("disabled");
    }
  },


  /*** API ***/

  loadTab: function(aTab) {
    if (aTab.getAttribute("ontap") != "true") {
      return;
    }
    aTab.removeAttribute("ontap");
    aTab.linkedBrowser.webNavigation.resume();
  },

  unloadTab: function(aTab) {
    // Ignore tabs that are already unloaded or are on the host whitelist.
    if (aTab.getAttribute("ontap") == "true") {
      return;
    }
    if (BarTabUtils.whiteListed(aTab.linkedBrowser.currentURI)) {
      return;
    }

    let tabbrowser = this.tabbrowser;

    // Make sure that we're not on this tab.  If we are, find the
    // closest tab that isn't on the bar tab.
    if (aTab.selected) {
      let activeTab = this.findClosestLoadedTab(aTab);
      if (activeTab) {
        tabbrowser.selectedTab = activeTab;
      }
    }

    var sessionstore = BarTabUtils.mSessionStore;
    var state = sessionstore.getTabState(aTab);
    var newtab = tabbrowser.addTab();

    // The user might not have the 'extensions.bartap.tapRestoredTabs'
    // preference enabled but still wants to unload this tab.  That's
    // why we need to make sure we hook into the new tab before
    // restoring the tab state.
    if (newtab.getAttribute("ontap") != "true") {
      newtab.setAttribute("ontap", "true");
      (new BarTabWebNavigation()).hook(newtab);
    }
    sessionstore.setTabState(newtab, state);

    // Move the new tab next to the one we're removing, but not in
    // front of it as that confuses Tree Style Tab.
    tabbrowser.moveTabTo(newtab, aTab._tPos + 1);

    // Restore tree when using Tree Style Tab
    if (tabbrowser.treeStyleTab) {
      let children = tabbrowser.treeStyleTab.getChildTabs(aTab);
      children.forEach(function(aChild) {
          tabbrowser.treeStyleTab.attachTabTo(
              aChild, newtab, {dontAnimate: true});
        });
    }

    // Close the original tab.  We're taking the long way round to ensure the
    // nsISessionStore service won't save this in the recently closed tabs.
    tabbrowser._endRemoveTab(tabbrowser._beginRemoveTab(aTab, true, null, false));
  },

  unloadOtherTabs: function(aTab) {
    var tabbrowser = this.tabbrowser;

    // Make sure we're sitting on the tab that isn't going to be unloaded.
    if (tabbrowser.selectedTab != aTab) {
      tabbrowser.selectedTab = aTab;
    }

    // unloadTab() mutates the tabs so the only sane thing to do is to
    // copy the list of tabs now and then work off that list.
    var tabs = [];
    for (let i = 0; i < tabbrowser.mTabs.length; i++) {
      tabs.push(tabbrowser.mTabs[i]);
    }
    var self = this;
    tabs.forEach(function(tab) {
        if (tab != aTab) {
          self.unloadTab(tab);
        }
      });
  },

  toggleHostWhitelist: function(aTab) {
    var uri = aTab.linkedBrowser.currentURI;
    try {
      var host = uri.host;
    } catch(ex) {
      // Most likely uri.host doesn't exist.  Ignore then.
      return;
    }

    let whitelist = BarTabUtils.getHostWhitelist();
    let index = whitelist.indexOf(host);
    if (index == -1) {
      whitelist.push(host);
    } else {
      whitelist.splice(index, 1);
    }

    BarTabUtils.setHostWhitelist(whitelist);
  },

  /*
   * In relation to a given tab, find the closest tab that is loaded.
   * Note: if there's no such tab available, this will return unloaded
   * tabs as a last resort.
   */
  findClosestLoadedTab: function(aTab) {
    var tabbrowser = this.tabbrowser;

    // Shortcut: if this is the only tab available, we're not going to
    // find another active one, are we...
    if (tabbrowser.mTabs.length == 1) {
      return null;
    }

    // The most obvious choice would be the owner tab, if it's active.
    if (aTab.owner && aTab.owner.getAttribute("ontap") != "true") {
      return aTab.owner;
    }

    // Otherwise walk the tab list and see if we can find an active one.
    let i = 1;
    while ((aTab._tPos - i >= 0) ||
           (aTab._tPos + i < tabbrowser.mTabs.length)) {
      if (aTab._tPos + i < tabbrowser.mTabs.length) {
        if (tabbrowser.mTabs[aTab._tPos+i].getAttribute("ontap") != "true") {
          return tabbrowser.mTabs[aTab._tPos+i];
        }
      }
      if (aTab._tPos - i >= 0) {
        if (tabbrowser.mTabs[aTab._tPos-i].getAttribute("ontap") != "true") {
          return tabbrowser.mTabs[aTab._tPos-i];
        }
      }
      i++;
    }

    // Fallback: there isn't an active tab available, so we're going
    // to have to nominate a non-active one.
    if (aTab.owner) {
      return aTab.owner;
    }
    if (aTab.nextSibling) {
      return aTab.nextSibling;
    }
    return aTab.previousSibling;
  }

};


// Initialize BarTab as soon as possible.
window.addEventListener("DOMContentLoaded", function() {
    window.removeEventListener("DOMContentLoaded", arguments.callee, false);
    var tabbrowser = document.getElementById("content");
    (new BarTabHandler).init(tabbrowser);
}, false);
