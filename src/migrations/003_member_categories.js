import pool from '../config/db.js';

/**
 * Migration: Create member_categories table + seed predefined types
 * Also adds type-specific columns to members table
 */
export const migrateMemberCategories = async () => {
    try {
        // Create member_categories table
        await pool.query(`
      CREATE TABLE IF NOT EXISTS member_categories (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        slug VARCHAR(100) NOT NULL UNIQUE,
        description TEXT,
        is_predefined BOOLEAN DEFAULT false,
        icon VARCHAR(50),
        color VARCHAR(50),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

        // Seed predefined categories if empty
        const { rows } = await pool.query(`SELECT COUNT(*)::int AS cnt FROM member_categories WHERE is_predefined = true`);
        if (rows[0].cnt === 0) {
            await pool.query(`
        INSERT INTO member_categories (name, slug, description, is_predefined, icon, color) VALUES
          ('Client', 'CLIENT', 'Clients who purchase plots or properties', true, 'UserCheck', 'blue'),
          ('Farmer', 'FARMER', 'Farmers who sell land', true, 'Tractor', 'emerald'),
          ('Member', 'MEMBER', 'General registered members', true, 'Users', 'purple'),
          ('Broker', 'BROKER', 'Real estate brokers and agents', true, 'Handshake', 'amber'),
          ('Partner', 'PARTNER', 'Business partners', true, 'Users', 'cyan'),
          ('Vendor', 'VENDOR', 'Vendors and service providers', true, 'Store', 'orange'),
          ('Employee', 'EMPLOYEE', 'Company employees and staff', true, 'UserCog', 'indigo'),
          ('Other', 'OTHER', 'Other category', true, 'HelpCircle', 'slate')
        ON CONFLICT (slug) DO NOTHING;
      `);
        }

        // Add type-specific columns to members table (safe to run multiple times)
        const alterQueries = [
            // Farmer-specific
            `ALTER TABLE members ADD COLUMN IF NOT EXISTS land_area VARCHAR(100)`,
            `ALTER TABLE members ADD COLUMN IF NOT EXISTS crop_type VARCHAR(200)`,
            `ALTER TABLE members ADD COLUMN IF NOT EXISTS farm_location VARCHAR(200)`,
            `ALTER TABLE members ADD COLUMN IF NOT EXISTS irrigation_type VARCHAR(100)`,
            `ALTER TABLE members ADD COLUMN IF NOT EXISTS farming_experience VARCHAR(50)`,
            // Broker-specific
            `ALTER TABLE members ADD COLUMN IF NOT EXISTS license_number VARCHAR(100)`,
            `ALTER TABLE members ADD COLUMN IF NOT EXISTS commission_rate VARCHAR(50)`,
            `ALTER TABLE members ADD COLUMN IF NOT EXISTS operating_areas TEXT`,
            // Vendor-specific
            `ALTER TABLE members ADD COLUMN IF NOT EXISTS business_name VARCHAR(200)`,
            `ALTER TABLE members ADD COLUMN IF NOT EXISTS service_type VARCHAR(200)`,
            `ALTER TABLE members ADD COLUMN IF NOT EXISTS payment_terms VARCHAR(200)`,
        ];

        for (const q of alterQueries) {
            await pool.query(q);
        }

        console.log('✓ Migration applied: member_categories table created + type-specific columns added');
        return true;
    } catch (error) {
        if (error.message.includes('already exists')) {
            console.log('✓ Migration skipped: member_categories already exists');
            return true;
        }
        console.error('✗ Migration failed:', error.message);
        return false;
    }
};

export default migrateMemberCategories;
