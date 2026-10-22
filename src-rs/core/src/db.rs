//! SQLite persistence for XMLTV cache.
use sqlx::sqlite::{SqlitePool, SqlitePoolOptions};

use super::xmltv::XmltvCache;

pub async fn pool() -> anyhow::Result<Option<SqlitePool>> {
    // ponytail: env-gated, lazy init per call. Skip if DATABASE_URL not set.
    let db_url = std::env::var("DATABASE_URL").unwrap_or_default();
    if db_url.is_empty() {
        return Ok(None);
    }
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&db_url)
        .await?;
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS xmltv_channels (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            icon TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS xmltv_programmes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel_id TEXT NOT NULL,
            start_ts INTEGER NOT NULL,
            stop_ts INTEGER NOT NULL,
            title TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            icon TEXT NOT NULL DEFAULT '',
            UNIQUE(channel_id, start_ts, title)
        );
        "#,
    )
    .execute(&pool)
    .await?;
    Ok(Some(pool))
}

pub async fn persist(pool: &SqlitePool, cache: &XmltvCache) -> anyhow::Result<()> {
    let mut tx = pool.begin().await?;

    sqlx::query("DELETE FROM xmltv_channels").execute(&mut *tx).await?;
    sqlx::query("DELETE FROM xmltv_programmes")
        .execute(&mut *tx)
        .await?;

    for (id, ch) in &cache.channels {
        sqlx::query("INSERT INTO xmltv_channels (id, name, icon) VALUES (?, ?, ?)")
            .bind(id)
            .bind(&ch.name)
            .bind(&ch.icon)
            .execute(&mut *tx)
            .await?;
    }

    for (channel_id, progs) in &cache.programs {
        for p in progs {
            sqlx::query(
                "INSERT OR IGNORE INTO xmltv_programmes
                 (channel_id, start_ts, stop_ts, title, description, icon)
                 VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(channel_id)
            .bind(p.start)
            .bind(p.stop)
            .bind(&p.title)
            .bind(&p.desc)
            .bind(&p.icon)
            .execute(&mut *tx)
            .await?;
        }
    }

    tx.commit().await?;
    Ok(())
}
