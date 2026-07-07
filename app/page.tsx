import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

async function getDashboardStats() {
  const [ruleCount, batchStats, shipmentCount] = await Promise.all([
    prisma.universalImportRule.count(),
    prisma.universalImportBatch.aggregate({
      _count: { id: true },
      _sum: { totalRows: true, successRows: true, failedRows: true },
    }),
    prisma.universalImportShipment.count(),
  ]);

  return {
    totalRules: ruleCount,
    totalBatches: batchStats._count.id,
    totalRows: batchStats._sum.totalRows ?? 0,
    successRows: batchStats._sum.successRows ?? 0,
    failedRows: batchStats._sum.failedRows ?? 0,
    totalShipments: shipmentCount,
  };
}

export default async function HomePage() {
  const stats = await getDashboardStats();
  const successRate = stats.totalRows > 0
    ? Math.round((stats.successRows / stats.totalRows) * 100)
    : 0;

  return (
    <main className="dashboard-shell">
      <div className="dashboard-main">
        {/* ── Topbar ── */}
        <header className="global-topbar">
          <div className="global-topbar-nav">
            <span className="brand-tag">AI</span>
            <strong className="brand-title">智能多格式批量下单系统</strong>
          </div>
          <div className="global-topbar-tools">
            <a href="/universal-import" className="global-nav-item active">
              进入工作台
            </a>
          </div>
        </header>

        {/* ── Content ── */}
        <section className="workspace-shell">
          {/* ── Hero ── */}
          <div className="home-hero">
            <h1 className="home-hero-title">数据看板</h1>
            <p className="home-hero-desc">
              实时掌握导入规则、运单批次与执行状态，一目了然。
            </p>
          </div>

          {/* ── Stats Grid ── */}
          <div className="overview-grid">
            <article className="overview-card accent">
              <p>规则总数</p>
              <strong>{stats.totalRules}</strong>
              <span>已保存的导入规则模板</span>
            </article>
            <article className="overview-card">
              <p>运单批次</p>
              <strong>{stats.totalBatches}</strong>
              <span>历史导入批次</span>
            </article>
            <article className="overview-card success">
              <p>运单总数</p>
              <strong>{stats.totalShipments}</strong>
              <span>已生成的运单记录</span>
            </article>
            <article className="overview-card warning">
              <p>成功率</p>
              <strong>{successRate}%</strong>
              <span>{stats.successRows} / {stats.totalRows} 行成功</span>
            </article>
          </div>

          {/* ── Detail Stats ── */}
          <div className="home-detail-grid">
            <div className="home-detail-card">
              <p className="home-detail-label">总数据行</p>
              <strong>{stats.totalRows}</strong>
            </div>
            <div className="home-detail-card success-border">
              <p className="home-detail-label">成功行</p>
              <strong>{stats.successRows}</strong>
            </div>
            <div className="home-detail-card danger-border">
              <p className="home-detail-label">失败行</p>
              <strong>{stats.failedRows}</strong>
            </div>
          </div>

          {/* ── Guided Operation Flow ── */}
          <div className="home-guide-section">
            <div className="home-guide-header">
              <h2>操作引导</h2>
              <p>三步完成多格式批量导入，高效下单</p>
            </div>

            <div className="guide-flow">
              {/* Step 1 */}
              <div className="guide-step">
                <div className="guide-step-icon">📤</div>
                <h3>上传文件</h3>
                <p>支持 Excel、TXT、PDF 等多种格式，拖拽或点击上传。</p>
                <span className="guide-step-badge">Step 1</span>
              </div>

              <div className="guide-arrow">
                <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
                  <path d="M4 16h20m-6-6l6 6-6 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>

              {/* Step 2 */}
              <div className="guide-step">
                <div className="guide-step-icon">🤖</div>
                <h3>AI 智能解析 &amp; 映射</h3>
                <p>自动识别表头，智能推荐字段映射，人工确认即可。</p>
                <span className="guide-step-badge">Step 2</span>
              </div>

              <div className="guide-arrow">
                <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
                  <path d="M4 16h20m-6-6l6 6-6 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>

              {/* Step 3 */}
              <div className="guide-step">
                <div className="guide-step-icon">💾</div>
                <h3>保存规则</h3>
                <p>将当前映射与配置保存为可复用规则，下次一键加载。</p>
                <span className="guide-step-badge">Step 3</span>
              </div>

              <div className="guide-arrow">
                <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
                  <path d="M4 16h20m-6-6l6 6-6 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>

              {/* Step 4 */}
              <div className="guide-step">
                <div className="guide-step-icon">📦</div>
                <h3>一键下单</h3>
                <p>批量生成运单，自动处理重复与缺失，实时反馈结果。</p>
                <span className="guide-step-badge">Step 4</span>
              </div>
            </div>

            {/* CTA */}
            <div className="guide-cta">
              <a href="/universal-import" className="primary-button" style={{ fontSize: "1.05rem", minHeight: 48, padding: "0 28px", borderRadius: 12, textDecoration: "none", display: "inline-flex", alignItems: "center" }}>
                开始导入 →
              </a>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
