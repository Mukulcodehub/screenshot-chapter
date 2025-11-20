const os = require("os");

function getServerMAC() {
  try {
    const interfaces = os.networkInterfaces();
    for (const interfaceName of Object.keys(interfaces)) {
      const netInterface = interfaces[interfaceName];
      if (!netInterface) {
        continue;
      }
      for (const detail of netInterface) {
        if (detail && !detail.internal && detail.mac && detail.mac !== "00:00:00:00:00:00") {
          return detail.mac;
        }
      }
    }
  } catch (err) {
    console.error("Failed to retrieve server MAC address:", err);
  }
  return "00:00:00:00:00:00";
}

module.exports = getServerMAC;

