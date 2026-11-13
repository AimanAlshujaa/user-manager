-- =============================================================================
-- MikroTik Hotspot & FreeRADIUS 3.x Management System - Database Migrations
-- Target Engine: MariaDB 10.11+ / MySQL 8.0+ (Database: `radius`)
-- =============================================================================

USE `radius`;

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- -----------------------------------------------------------------------------
-- 1. Performance Indexes on Core FreeRADIUS Tables (Safe / Non-Destructive)
-- -----------------------------------------------------------------------------
-- Ensure high-speed lookups during batch collision checks, accounting queries,
-- and profile synchronization without altering standard FreeRADIUS behavior.

CREATE INDEX IF NOT EXISTS `idx_radcheck_user_attr` ON `radcheck` (`username`, `attribute`);
CREATE INDEX IF NOT EXISTS `idx_radusergroup_user` ON `radusergroup` (`username`);
CREATE INDEX IF NOT EXISTS `idx_radusergroup_group` ON `radusergroup` (`groupname`);
CREATE INDEX IF NOT EXISTS `idx_radgroupreply_group_attr` ON `radgroupreply` (`groupname`, `attribute`);
CREATE INDEX IF NOT EXISTS `idx_radgroupcheck_group_attr` ON `radgroupcheck` (`groupname`, `attribute`);
CREATE INDEX IF NOT EXISTS `idx_radacct_active_sessions` ON `radacct` (`acctstoptime`, `username`, `nasipaddress`);
CREATE INDEX IF NOT EXISTS `idx_radacct_starttime` ON `radacct` (`acctstarttime`);

-- -----------------------------------------------------------------------------
-- 2. Custom Table: `resellers` (RBAC, Agents & Sub-Accounts)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `resellers` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(120) NOT NULL,
  `username` VARCHAR(64) NOT NULL,
  `password_hash` VARCHAR(255) NOT NULL,
  `role` ENUM('SUPER_ADMIN', 'RESELLER') NOT NULL DEFAULT 'RESELLER',
  `phone` VARCHAR(32) DEFAULT NULL,
  `balance` DECIMAL(12, 2) NOT NULL DEFAULT 0.00 COMMENT 'Current wallet balance',
  `credit_limit` DECIMAL(12, 2) NOT NULL DEFAULT 0.00 COMMENT 'Max negative balance allowed',
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_resellers_username` (`username`),
  KEY `idx_resellers_active_role` (`is_active`, `role`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- 3. Custom Table: `profiles_meta` (Hotspot Plans & Bandwidth Metadata)
-- -----------------------------------------------------------------------------
-- Note: `name` maps 1:1 to `radusergroup.groupname`, `radgroupreply.groupname`,
-- and `radgroupcheck.groupname`.
CREATE TABLE IF NOT EXISTS `profiles_meta` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(64) NOT NULL COMMENT 'Maps directly to FreeRADIUS groupname',
  `display_name` VARCHAR(120) NOT NULL COMMENT 'Arabic/Friendly title for printed cards',
  `price` DECIMAL(10, 2) NOT NULL DEFAULT 0.00 COMMENT 'End-user retail price',
  `cost_price` DECIMAL(10, 2) NOT NULL DEFAULT 0.00 COMMENT 'Reseller wholesale deduction cost',
  `speed_limit` VARCHAR(64) NOT NULL DEFAULT '2M/2M' COMMENT 'Mikrotik-Rate-Limit format e.g. 2M/2M',
  `time_limit` INT UNSIGNED DEFAULT NULL COMMENT 'Max-All-Session / Session-Timeout in seconds (NULL = unlimited)',
  `data_limit_mb` INT UNSIGNED DEFAULT NULL COMMENT 'Total quota in MB (mapped to Mikrotik-Total-Limit)',
  `validity_days` INT UNSIGNED DEFAULT NULL COMMENT 'Expiration window in days after first login',
  `simultaneous_use` INT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'Mapped to Simultaneous-Use in radgroupcheck',
  `port_limit` INT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'Mapped to Port-Limit in radgroupreply',
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_profiles_meta_name` (`name`),
  KEY `idx_profiles_meta_active` (`is_active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- 4. Custom Table: `voucher_batches` (Batch Header & Audit Trail)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `voucher_batches` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `batch_code` VARCHAR(40) NOT NULL,
  `profile_id` INT UNSIGNED NOT NULL,
  `quantity` INT UNSIGNED NOT NULL,
  `reseller_id` INT UNSIGNED NOT NULL,
  `voucher_type` ENUM('PIN_ONLY', 'USER_PASS') NOT NULL DEFAULT 'PIN_ONLY',
  `prefix` VARCHAR(16) DEFAULT '',
  `code_length` TINYINT UNSIGNED NOT NULL DEFAULT 8,
  `charset_type` ENUM('NUMERIC', 'ALPHANUMERIC_UPPER', 'ALPHANUMERIC_MIXED') NOT NULL DEFAULT 'NUMERIC',
  `unit_cost` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  `total_cost` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `notes` VARCHAR(255) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_voucher_batches_code` (`batch_code`),
  KEY `idx_voucher_batches_reseller` (`reseller_id`, `created_at`),
  KEY `idx_voucher_batches_profile` (`profile_id`),
  CONSTRAINT `fk_batches_profile` FOREIGN KEY (`profile_id`) REFERENCES `profiles_meta` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_batches_reseller` FOREIGN KEY (`reseller_id`) REFERENCES `resellers` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- 5. Auxiliary Mapping Table: `voucher_cards`
-- -----------------------------------------------------------------------------
-- Links individual FreeRADIUS `radcheck.username` entries back to their
-- `voucher_batches.id` and `reseller_id` for fast printing, RBAC filtering,
-- and lifecycle tracking (Unused / Active / Expired / Disabled) without
-- polluting or modifying FreeRADIUS's native `radcheck` columns.
CREATE TABLE IF NOT EXISTS `voucher_cards` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `batch_id` BIGINT UNSIGNED NOT NULL,
  `reseller_id` INT UNSIGNED NOT NULL,
  `profile_id` INT UNSIGNED NOT NULL,
  `username` VARCHAR(64) NOT NULL,
  `cleartext_password` VARCHAR(64) NOT NULL,
  `serial_number` VARCHAR(32) NOT NULL,
  `status` ENUM('UNUSED', 'ACTIVE', 'EXPIRED', 'DISABLED') NOT NULL DEFAULT 'UNUSED',
  `first_used_at` DATETIME DEFAULT NULL,
  `expires_at` DATETIME DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_voucher_cards_username` (`username`),
  UNIQUE KEY `uk_voucher_cards_serial` (`serial_number`),
  KEY `idx_voucher_cards_batch` (`batch_id`),
  KEY `idx_voucher_cards_reseller_status` (`reseller_id`, `status`),
  KEY `idx_voucher_cards_profile` (`profile_id`),
  CONSTRAINT `fk_cards_batch` FOREIGN KEY (`batch_id`) REFERENCES `voucher_batches` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_cards_reseller` FOREIGN KEY (`reseller_id`) REFERENCES `resellers` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_cards_profile` FOREIGN KEY (`profile_id`) REFERENCES `profiles_meta` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- 6. Custom Table: `reseller_transactions` (Financial Ledger for Auditability)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `reseller_transactions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `reseller_id` INT UNSIGNED NOT NULL,
  `batch_id` BIGINT UNSIGNED DEFAULT NULL,
  `type` ENUM('DEPOSIT', 'BATCH_DEDUCTION', 'REFUND', 'ADJUSTMENT') NOT NULL,
  `amount` DECIMAL(12, 2) NOT NULL,
  `balance_before` DECIMAL(12, 2) NOT NULL,
  `balance_after` DECIMAL(12, 2) NOT NULL,
  `description` VARCHAR(255) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_transactions_reseller_date` (`reseller_id`, `created_at`),
  CONSTRAINT `fk_tx_reseller` FOREIGN KEY (`reseller_id`) REFERENCES `resellers` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;
