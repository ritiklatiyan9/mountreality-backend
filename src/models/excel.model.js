import MasterModel from './MasterModel.js';

class ExcelModel extends MasterModel {
  constructor() {
    super('excel_files');
  }

  /**
   * Find all excel files created by a user, ordered by last updated
   */
  async findAllBySite(siteId, pool, folderId = null) {
    const query = `
      SELECT ef.id, ef.name, ef.created_by, ef.updated_by,
             ef.created_at, ef.updated_at, ef.folder_id, ef.file_type, ef.site_id,
             u.name as creator_name
      FROM excel_files ef
      LEFT JOIN users u ON ef.created_by = u.id
      WHERE ef.site_id = $1
        AND ${folderId ? 'ef.folder_id = $2' : 'ef.folder_id IS NULL'}
      ORDER BY ef.updated_at DESC
    `;
    const params = folderId ? [siteId, folderId] : [siteId];
    const result = await pool.query(query, params);
    return result.rows;
  }

  /**
   * Find recent files for a user (for sidebar quick-access)
   */
  async findRecent(userId, limit = 5, pool) {
    const query = `
      SELECT id, name, updated_at
      FROM excel_files
      WHERE created_by = $1
      ORDER BY updated_at DESC
      LIMIT $2
    `;
    const result = await pool.query(query, [userId, limit]);
    return result.rows;
  }

  /**
   * Get a single file with full sheet data
   */
  async findByIdWithData(id, pool) {
    const query = `
      SELECT ef.*, u.name as creator_name
      FROM excel_files ef
      LEFT JOIN users u ON ef.created_by = u.id
      WHERE ef.id = $1
    `;
    const result = await pool.query(query, [id]);
    return result.rows[0];
  }

  /**
   * Update the file metadata (especially when overwriting the S3 file)
   */
  async updateS3Details(id, s3Key, sizeBytes, userId, pool) {
    const query = `
      UPDATE excel_files
      SET s3_key = $2, size_bytes = $3, updated_by = $4, updated_at = NOW()
      WHERE id = $1
      RETURNING id, name, updated_at
    `;
    const result = await pool.query(query, [id, s3Key, sizeBytes, userId]);
    return result.rows[0];
  }

  /**
   * Rename a file
   */
  async rename(id, name, userId, pool) {
    const query = `
      UPDATE excel_files
      SET name = $2, updated_by = $3, updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `;
    const result = await pool.query(query, [id, name, userId]);
    return result.rows[0];
  }

  /**
   * Move a file into a folder (or to root when folderId is null).
   * Only succeeds when the target folder belongs to the same site as the
   * file — the WHERE guard makes a cross-site or non-existent target a
   * no-op (returns undefined) rather than silently reparenting.
   */
  async moveToFolder(id, folderId, pool) {
    const query = `
      UPDATE excel_files ef
      SET folder_id = $2, updated_at = NOW()
      WHERE ef.id = $1
        AND (
          $2::int IS NULL
          OR EXISTS (SELECT 1 FROM file_folders ff WHERE ff.id = $2 AND ff.site_id = ef.site_id)
        )
      RETURNING id, name, folder_id, site_id, file_type, updated_at
    `;
    const result = await pool.query(query, [id, folderId]);
    return result.rows[0];
  }

  /**
   * Duplicate a file (Note: For S3, duplicating the DB record means both records point to the same S3 object
   * until one is edited. If edits create new objects, this is fine. If not, S3 object needs to be cloned).
   * For now, we will just copy the reference.
   */
  async duplicate(id, userId, pool) {
    const query = `
      INSERT INTO excel_files (name, s3_key, size_bytes, site_id, folder_id, file_type, created_by, updated_by)
      SELECT name || ' (Copy)', s3_key, size_bytes, site_id, folder_id, file_type, $2, $2
      FROM excel_files
      WHERE id = $1
      RETURNING *
    `;
    const result = await pool.query(query, [id, userId]);
    return result.rows[0];
  }
}

export const excelModel = new ExcelModel();
