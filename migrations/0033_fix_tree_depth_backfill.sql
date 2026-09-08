-- Reset tree depth so runtime reconcileDownstreamTreeCount(maxCrawlDepth) owns the canonical depth.
UPDATE scheduler_state SET downstream_tree_max_depth = 0 WHERE id = 1;
