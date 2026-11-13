-- =============================================================================
-- RadiusPro - Migration 002 (run AFTER FreeRADIUS schema.sql and migration 001)
-- Target: MariaDB 10.5+  (uses ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS)
-- =============================================================================
USE `radius`;

-- Notes field shown in the User Details modal
ALTER TABLE `voucher_cards` ADD COLUMN IF NOT EXISTS `notes` VARCHAR(255) DEFAULT NULL;

-- Fast lookups of a user's open / closed sessions
CREATE INDEX IF NOT EXISTS `idx_radacct_username_stop` ON `radacct` (`username`, `acctstoptime`);

-- Archive table used by "Reset usage": closed sessions are MOVED here (history is kept,
-- but the FreeRADIUS sqlcounter queries on `radacct` no longer count them).
CREATE TABLE IF NOT EXISTS `radacct_archive` LIKE `radacct`;

-- Maps what MikroTik reports (Called-Station-Id = hotspot server name, or NAS-Port-Id =
-- interface/VLAN) to the real IP/name of the modem or access point behind it.
-- RADIUS itself does NOT know the AP IP; this mapping is what makes the "Modem/AP IP" column real.
CREATE TABLE IF NOT EXISTS `access_points` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `nas_ip` VARCHAR(128) DEFAULT NULL COMMENT 'NULL = match on any NAS',
  `match_type` ENUM('CALLED_STATION_ID', 'NAS_PORT_ID') NOT NULL DEFAULT 'CALLED_STATION_ID',
  `match_value` VARCHAR(128) NOT NULL COMMENT 'e.g. hotspot server name "hs-north" or interface "vlan20"',
  `ap_ip` VARCHAR(64) NOT NULL,
  `ap_name` VARCHAR(120) NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_ap_match` (`nas_ip`, `match_type`, `match_value`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
