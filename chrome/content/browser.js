Components.utils.import("resource://bartap/prototypes.js");

var BarTap = {

  handleEvent: function(event) {
    switch (event.type) {
    case 'DOMContentLoaded':
      this.init();
      return;
    case 'SSTabRestoring':
      this.onTabRestoring(event);
      return;
    case 'TabOpen':
      this.onTabOpen(event);
      return;
    case 'TabSelect':
      this.onTabSelect(event);
      return;
    case 'TabClose':
      this.onTabClose(event);
      return;
    case 'popupshowing':
      this.onPopupShowing(event);
      return;
    }
  },

  init: function() {
    window.removeEventListener("DOMContentLoaded", this, false);

    this.l10n = document.getElementById('bartap-strings');

    let tabbrowser = document.getElementById("content");
    this.initTabBrowser(tabbrowser);
  },

  /*
   * Initialize the tab browser.  This is deliberately its own method
   * so that extensions that have other tabbrowsers can call it.
   */
  initTabBrowser: function(tabbrowser) {
    tabbrowser.tabContainer.addEventListener('SSTabRestoring', this, false);
    tabbrowser.tabContainer.addEventListener('TabOpen', this, false);
    tabbrowser.tabContainer.addEventListener('TabSelect', this, false);
    tabbrowser.tabContainer.addEventListener('TabClose', this, false);

    // Initialize timer
    tabbrowser.BarTabTimer = new BarTabTimer(tabbrowser);

    // We need an event listener for the context menu so that we can
    // adjust the label of the whitelist menu item
    let popup = tabbrowser.tabContainer.contextMenu;
    if (!popup) {
      // In Firefox <3.7, the tab context menu lives inside the tabbrowser.
      popup = document.getAnonymousElementByAttribute(
          tabbrowser, "anonid", "tabContextMenu");
      let before = document.getAnonymousElementByAttribute(
          tabbrowser, "id", "context_openTabInWindow");
      for each (let menuitemid in ["context_putOnTap",
                                   "context_putAllOnTapBut",
                                   "context_neverPutOnTap",
                                   "context_tapSeparator"]) {
        let menuitem = document.getElementById(menuitemid);
        popup.insertBefore(menuitem, before);
      }
    }
    popup.addEventListener('popupshowing', this, false);
  },


  /*** Core machinery ***/

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
      this.getTabBrowserForTab(tab).BarTabTimer.startTimer(tab);
    }
  },

  /*
   * Listen to the 'SSTabRestoring' event from the nsISessionStore
   * service and hook into restored tabs if the user wants to prevent
   * restored tabs from loading.
   */
  onTabRestoring: function(event) {
    if (!BarTabUtils.mPrefs.getBoolPref("extensions.bartap.tapRestoredTabs")) {
      return;
    }
    let tab = event.originalTarget;
    if (tab.selected || tab.getAttribute("ontap") == "true") {
      return;
    }
    tab.setAttribute("ontap", "true");
    (new BarTabWebNavigation()).hook(tab);
  },

  onTabSelect: function(event) {
    var tab = event.originalTarget;
    if (tab.getAttribute("ontap") != "true") {
      return;
    }

    // Always load a blank page immediately
    let uri = tab.linkedBrowser.webNavigation.currentURI;
    if (!uri || (uri.spec == "about:blank")) {
      this.loadTabContents(tab);
      return;      
    }

    switch (BarTabUtils.mPrefs.getIntPref("extensions.bartap.loadOnSelect")) {
    case 1:
      // Load immediately
      this.loadTabContents(tab);
      return;
    case 2:
      // Load after delay
      let delay = BarTabUtils.mPrefs.getIntPref("extensions.bartap.loadOnSelectDelay");
      window.setTimeout(function() {
          if (tab.selected) {
            BarTap.loadTabContents(tab);
          }
        }, delay);
      return;
    case 0:
      // Ask whether to load
      let tabbrowser = this.getTabBrowserForTab(tab);
      let box = tabbrowser.getNotificationBox(tab.linkedBrowser);
      let label = this.l10n.getString("loadNotification");
      let buttons = [{label: this.l10n.getString("loadButton"),
                      accessKey: this.l10n.getString("loadButton.accesskey"),
                      callback: function() {BarTap.loadTabContents(tab);}}];
      let bar = box.appendNotification(label, 'bartap-load', "",
                                       box.PRIORITY_INFO_MEDIUM, buttons);
      return;
    }
  },

  loadTabContents: function(tab) {
    tab.removeAttribute("ontap");
    tab.linkedBrowser.webNavigation.resume();
  },

  onTabClose: function(event) {
    if (!BarTabUtils.mPrefs.getBoolPref("extensions.bartap.findClosestUntappedTab")) {
      return;
    }
    let tab = event.originalTarget;
    if (!tab.selected) {
      return;
    }
    let tabbrowser = this.getTabBrowserForTab(tab);
    let activeTab = this.findClosestUntappedTab(tab, tabbrowser);
    if (activeTab) {
      tabbrowser.selectedTab = activeTab;
    }
  },


  /*** Handlers for commands (e.g. context menu items) ***/

  onPopupShowing: function(event) {
    var tab =  document.popupNode.localName == "tab" ?
          document.popupNode : gBrowser.selectedTab;

    var neverputontap = document.getElementById("context_neverPutOnTap");
    var putontap = document.getElementById("context_putOnTap");

    if (tab.getAttribute("ontap") == "true") {
      putontap.setAttribute("disabled", "true");
    }

    let host;
    try {
      host = tab.linkedBrowser.currentURI.host;
    } catch (ex) {
      // Most likely uri.host doesn't exist which probably means whitelisting
      // doesn't make sense on this tab.  Don't show the menu item
      neverputontap.setAttribute("hidden", "true");
      putontap.removeAttribute("disabled");
      return;
    }

    let label = this.l10n.getFormattedString('neverPutOnTap', [host]);
    neverputontap.setAttribute("label", label);
    neverputontap.removeAttribute("hidden");
    if (BarTabUtils.getHostWhitelist().indexOf(host) == -1) {
      neverputontap.removeAttribute("checked");
      putontap.removeAttribute("disabled");
    } else {
      neverputontap.setAttribute("checked", "true");
      putontap.setAttribute("disabled", "true");
    }
  },

  putOnTap: function(aTab, aTabBrowser) {
    // Ignore tabs that are already unloaded or are on the host whitelist.
    if (aTab.getAttribute("ontap") == "true") {
      return;
    }
    try {
      let uri = aTab.linkedBrowser.currentURI;
      if (BarTabUtils.getHostWhitelist().indexOf(uri.host) != -1) {
        return;
      }
    } catch(ex) {
      // Most likely uri.host failed.  No matter, just carry on.
    }

    if (!aTabBrowser) {
      aTabBrowser = this.getTabBrowserForTab(aTab);
    }
    // Make sure that we're not on this tab.  If we are, find the
    // closest tab that isn't on the bar tab.
    if (aTab.selected) {
      let activeTab = this.findClosestUntappedTab(aTab, aTabBrowser);
      if (activeTab) {
        aTabBrowser.selectedTab = activeTab;
      }
    }

    var sessionstore = BarTabUtils.mSessionStore;
    var state = sessionstore.getTabState(aTab);
    var newtab = aTabBrowser.addTab();

    // The user might not have the 'extensions.bartap.tapRestoredTabs'
    // preference enabled but still wants to put this tab on the bar tab.
    // That's why we need to make sure this attribute exists before
    // restoring the tab state.
    newtab.setAttribute("ontap", "true");
    newtab.linkedBrowser.setAttribute("ontap", "true");
    sessionstore.setTabState(newtab, state);

    // Move the new tab next to the one we're removing, but not in
    // front of it as that confuses Tree Style Tab.
    aTabBrowser.moveTabTo(newtab, aTab._tPos + 1);

    // Restore tree when using Tree Style Tab
    if (aTabBrowser.treeStyleTab) {
      let children = aTabBrowser.treeStyleTab.getChildTabs(aTab);
      children.forEach(function(aChild) {
          aTabBrowser.treeStyleTab.attachTabTo(
              aChild, newtab, {dontAnimate: true});
        });
    }

    // Close the original tab.  We're taking the long way round to ensure the
    // nsISessionStore service won't save this in the recently closed tabs.
    aTabBrowser._endRemoveTab(aTabBrowser._beginRemoveTab(aTab, true, null, false));
  },

  putAllOnTapBut: function(aTab, aTabBrowser) {
    if (!aTabBrowser) {
      aTabBrowser = this.getTabBrowserForTab(aTab);
    }
    // Make sure we're sitting on the tab that isn't going to be unloaded.
    if (aTabBrowser.selectedTab != aTab) {
      aTabBrowser.selectedTab = aTab;
    }

    // putOnTap() mutates the tabs so the only sane thing to do is to
    // copy the list of tabs now and then work off that list.
    var tabs = [];
    for (let i = 0; i < aTabBrowser.mTabs.length; i++) {
      tabs.push(aTabBrowser.mTabs[i]);
    }
    var self = this;
    tabs.forEach(function(tab) {
        if (tab != aTab) {
          self.putOnTap(tab, aTabBrowser);
        }
      });
  },

  toggleHostWhitelist: function(tab, tabbrowser) {
    // TODO the tab could also be tapped (so uri is about:blank)
    var uri = tab.linkedBrowser.currentURI;
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


  /*** Helper functions ***/

  /*
   * In relation to a given tab, find the closest tab that is loaded.
   * Note: if there's no such tab available, this will return unloaded
   * tabs as a last resort.
   */
  findClosestUntappedTab: function(aTab, aTabBrowser) {
    // Shortcut: if this is the only tab available, we're not going to
    // find another active one, are we...
    if (aTabBrowser.mTabs.length == 1) {
      return null;
    }

    // The most obvious choice would be the owner tab, if it's active.
    if (aTab.owner && aTab.owner.getAttribute("ontap") != "true") {
      return aTab.owner;
    }

    // Otherwise walk the tab list and see if we can find an active one.
    let i = 1;
    while ((aTab._tPos - i >= 0) ||
           (aTab._tPos + i < aTabBrowser.mTabs.length)) {
      if (aTab._tPos + i < aTabBrowser.mTabs.length) {
        if (aTabBrowser.mTabs[aTab._tPos+i].getAttribute("ontap") != "true") {
          return aTabBrowser.mTabs[aTab._tPos+i];
        }
      }
      if (aTab._tPos - i >= 0) {
        if (aTabBrowser.mTabs[aTab._tPos-i].getAttribute("ontap") != "true") {
          return aTabBrowser.mTabs[aTab._tPos-i];
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
  },

  getTabBrowserForTab: function(tab) {
    // Fuzzy test for FFX 3.7 where the tabbar lives outside the tabbrowser.
    if (tab.parentNode.tabbrowser) {
      return tab.parentNode.tabbrowser;
    }
    while (tab.localName != 'tabbrowser') {
      tab = tab.parentNode;
    }
    return tab;
  }

};


// Initialize BarTap as soon as possible.
window.addEventListener("DOMContentLoaded", BarTap, false);
