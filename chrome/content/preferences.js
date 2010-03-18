
var BarTapPreferences = {

  onLoad: function() {
    var menuitem = document.getElementById('tapAfterTimeout').selectedItem;
    this.onTimeoutChange(menuitem);
  },

  onTimeoutChange: function(menuitem) {
    var timerWidgets = document.getElementById('timerWidgets');
    var visibility = (menuitem.value == "true") ? 'visible' : 'hidden';
    timerWidgets.style.visibility = visibility;
  }

};
