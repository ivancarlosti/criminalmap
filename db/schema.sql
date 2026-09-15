CREATE TABLE IF NOT EXISTS nodes (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  label VARCHAR(255) NOT NULL,
  type VARCHAR(64) NOT NULL DEFAULT 'person',
  UNIQUE KEY uq_nodes_label (label)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS edges (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  from_node INT UNSIGNED NOT NULL,
  to_node INT UNSIGNED NOT NULL,
  topic_description TEXT NOT NULL,
  sources_json JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_edges_from (from_node),
  KEY idx_edges_to (to_node),
  CONSTRAINT fk_edges_from FOREIGN KEY (from_node) REFERENCES nodes(id) ON DELETE CASCADE,
  CONSTRAINT fk_edges_to FOREIGN KEY (to_node) REFERENCES nodes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Key/value application settings managed from the admin panel.
-- "key" is a reserved word in MySQL/MariaDB, so it is always backticked.
CREATE TABLE IF NOT EXISTS settings (
  `key` VARCHAR(64) NOT NULL PRIMARY KEY,
  `value` TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Saved (published) maps. A map is an immutable snapshot of the scratch graph
-- that only administrators can create, replace or delete, and that anybody can
-- read through its short URL (/{map_path_prefix}/{short_id}).
CREATE TABLE IF NOT EXISTS maps (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  short_id VARCHAR(32) NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT NULL,
  is_public TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_maps_short_id (short_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS map_nodes (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  map_id INT UNSIGNED NOT NULL,
  label VARCHAR(255) NOT NULL,
  type VARCHAR(64) NOT NULL DEFAULT 'person',
  UNIQUE KEY uq_map_nodes_map_label (map_id, label),
  KEY idx_map_nodes_map (map_id),
  CONSTRAINT fk_map_nodes_map FOREIGN KEY (map_id) REFERENCES maps(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS map_edges (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  map_id INT UNSIGNED NOT NULL,
  from_node INT UNSIGNED NOT NULL,
  to_node INT UNSIGNED NOT NULL,
  topic_description TEXT NOT NULL,
  sources_json JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_map_edges_map (map_id),
  KEY idx_map_edges_from (from_node),
  KEY idx_map_edges_to (to_node),
  CONSTRAINT fk_map_edges_map FOREIGN KEY (map_id) REFERENCES maps(id) ON DELETE CASCADE,
  CONSTRAINT fk_map_edges_from FOREIGN KEY (from_node) REFERENCES map_nodes(id) ON DELETE CASCADE,
  CONSTRAINT fk_map_edges_to FOREIGN KEY (to_node) REFERENCES map_nodes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
