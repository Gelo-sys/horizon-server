CREATE DATABASE IF NOT EXISTS horizon_db
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE horizon_db;

CREATE TABLE IF NOT EXISTS users (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  google_sub  VARCHAR(128)  NOT NULL UNIQUE,
  email       VARCHAR(255)  NOT NULL UNIQUE,
  name        VARCHAR(255)  NOT NULL,
  picture     TEXT,
  created_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS sessions (
  id         VARCHAR(128)     NOT NULL PRIMARY KEY,
  expires_at INT UNSIGNED     NOT NULL,
  data       TEXT,
  created_at DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_expires (expires_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS favorites (
  id          INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  user_id     INT UNSIGNED  NOT NULL,
  entry_key   VARCHAR(512)  NOT NULL,
  item1       JSON          NOT NULL,
  item2       JSON          NOT NULL,
  saved_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY uq_user_entry (user_id, entry_key),
  INDEX idx_user_saved (user_id, saved_at DESC)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS compare_history (
  id          INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  user_id     INT UNSIGNED  NOT NULL,
  item1       JSON          NOT NULL,
  item2       JSON          NOT NULL,
  compared_at DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_user_compared (user_id, compared_at DESC)
) ENGINE=InnoDB;
