import MasterModel from './MasterModel.js';

class MemberModel extends MasterModel {
  constructor() {
    super('members');
  }

  /** All members for a site with optional type filter */
  async findBySiteId(siteId, pool, memberType = null) {
    let query = `SELECT * FROM members WHERE site_id = $1`;
    const params = [siteId];
    if (memberType && memberType !== 'ALL') {
      query += ` AND member_type = $2`;
      params.push(memberType);
    }
    query += ` ORDER BY full_name ASC`;
    const result = await pool.query(query, params);
    return result.rows;
  }

  /** Lightweight list – only columns needed for the table view */
  async findBySiteIdList(siteId, pool, memberType = null) {
    let query = `SELECT m.id, m.member_type, m.full_name, m.father_name, m.phone, m.email,
      m.city, m.state, m.status, m.photo, m.alt_phone, m.whatsapp, m.address, m.pincode,
      m.aadhar_no, m.pan_no, m.voter_id, m.passport_no, m.driving_license_no,
      m.aadhar_front_url, m.aadhar_back_url, m.pan_card_url, m.voter_id_url,
      m.passport_url, m.driving_license_url, m.cheque_url, m.other_kyc_url, m.team,
      shared_kyc.id AS shared_kyc_case_id,
      shared_kyc.status AS shared_kyc_status,
      shared_kyc.document_count AS shared_kyc_document_count
      FROM members m
      LEFT JOIN LATERAL (
        SELECT k.id, k.status,
               (SELECT COUNT(*)::int FROM documents d WHERE d.kyc_case_id = k.id) AS document_count
          FROM kyc_cases k
         WHERE k.client_member_id = m.id
         ORDER BY CASE k.status WHEN 'VERIFIED' THEN 4 WHEN 'OCR_DONE' THEN 3 WHEN 'OCR_PENDING' THEN 2 ELSE 1 END DESC,
                  k.updated_at DESC NULLS LAST, k.id DESC
         LIMIT 1
      ) shared_kyc ON true
      WHERE m.site_id = $1`;
    const params = [siteId];
    if (memberType && memberType !== 'ALL') {
      query += ` AND m.member_type = $2`;
      params.push(memberType);
    }
    query += ` ORDER BY m.full_name ASC`;
    const result = await pool.query(query, params);
    return result.rows;
  }

  /** Search members */
  async search(siteId, q, pool) {
    const query = `
      SELECT * FROM members
      WHERE site_id = $1
        AND (
          full_name ILIKE $2
          OR father_name ILIKE $2
          OR phone ILIKE $2
          OR email ILIKE $2
          OR aadhar_no ILIKE $2
          OR pan_no ILIKE $2
          OR city ILIKE $2
        )
      ORDER BY full_name ASC
      LIMIT 50
    `;
    const result = await pool.query(query, [siteId, `%${q}%`]);
    return result.rows;
  }

  /** Summary counts by type */
  async getSummary(siteId, pool) {
    const query = `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE member_type = 'CLIENT')::int AS clients,
        COUNT(*) FILTER (WHERE member_type = 'FARMER')::int AS farmers,
        COUNT(*) FILTER (WHERE member_type = 'MEMBER')::int AS members,
        COUNT(*) FILTER (WHERE member_type = 'BROKER')::int AS brokers,
        COUNT(*) FILTER (WHERE member_type = 'PARTNER')::int AS partners,
        COUNT(*) FILTER (WHERE member_type = 'VENDOR')::int AS vendors,
        COUNT(*) FILTER (WHERE member_type = 'EMPLOYEE')::int AS employees,
        COUNT(*) FILTER (WHERE member_type = 'OTHER')::int AS others,
        COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active,
        COUNT(*) FILTER (WHERE status = 'INACTIVE')::int AS inactive
      FROM members
      WHERE site_id = $1
    `;
    const result = await pool.query(query, [siteId]);
    return result.rows[0];
  }

  /** Check duplicate by phone within a site */
  async findByPhone(siteId, phone, pool) {
    const query = `SELECT * FROM members WHERE site_id = $1 AND phone = $2`;
    const result = await pool.query(query, [siteId, phone]);
    return result.rows[0];
  }

  /** Autocomplete values */
  async getAutocomplete(siteId, pool) {
    const [cities, occupations, companies, references] = await Promise.all([
      pool.query(`SELECT DISTINCT city AS val FROM members WHERE site_id = $1 AND city IS NOT NULL AND city != '' ORDER BY val`, [siteId]),
      pool.query(`SELECT DISTINCT occupation AS val FROM members WHERE site_id = $1 AND occupation IS NOT NULL AND occupation != '' ORDER BY val`, [siteId]),
      pool.query(`SELECT DISTINCT company_name AS val FROM members WHERE site_id = $1 AND company_name IS NOT NULL AND company_name != '' ORDER BY val`, [siteId]),
      pool.query(`SELECT DISTINCT reference AS val FROM members WHERE site_id = $1 AND reference IS NOT NULL AND reference != '' ORDER BY val`, [siteId]),
    ]);
    return {
      cities: cities.rows.map(r => r.val),
      occupations: occupations.rows.map(r => r.val),
      companies: companies.rows.map(r => r.val),
      references: references.rows.map(r => r.val),
    };
  }
}

export const memberModel = new MemberModel();
