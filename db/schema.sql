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
