-- Create database with UTF8 encoding
CREATE DATABASE serp_collector WITH ENCODING 'UTF8';

-- Connect to the database
\c serp_collector;

-- Projects table (internal use only)
CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT true
);

-- Queries table with project association
CREATE TABLE queries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    search_term TEXT NOT NULL, -- No length limit for long Persian queries
    status VARCHAR(20) DEFAULT 'pending',
    priority INTEGER DEFAULT 0, -- Higher priority processed first
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP
);

-- Results table
CREATE TABLE results (
    id SERIAL PRIMARY KEY,
    query_id UUID REFERENCES queries(id) ON DELETE CASCADE,
    page_number INTEGER,
    position INTEGER,
    title TEXT,
    url TEXT,
    domain VARCHAR(255), -- For rank tracking
    description TEXT,
    result_type VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Suggestions table
CREATE TABLE suggestions (
    id SERIAL PRIMARY KEY,
    query_id UUID REFERENCES queries(id) ON DELETE CASCADE,
    suggestion TEXT
);

-- Related searches table
CREATE TABLE related_searches (
    id SERIAL PRIMARY KEY,
    query_id UUID REFERENCES queries(id) ON DELETE CASCADE,
    search_term TEXT
);

-- Extension tracking (optional)
CREATE TABLE api_keys (
    id SERIAL PRIMARY KEY,
    api_key VARCHAR(64) UNIQUE NOT NULL,
    extension_id VARCHAR(255),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX idx_queries_status ON queries(status, priority DESC, created_at);
CREATE INDEX idx_results_domain ON results(domain);
CREATE INDEX idx_results_query_page ON results(query_id, page_number);
CREATE INDEX idx_queries_project ON queries(project_id);

-- Sample data
INSERT INTO api_keys (api_key) VALUES ('your_secure_api_key_here');
INSERT INTO projects (name, description) VALUES 
('Default', 'General SERP tracking'),
('Competitors', 'Competitor domain tracking'),
('Keywords', 'Keyword research project');