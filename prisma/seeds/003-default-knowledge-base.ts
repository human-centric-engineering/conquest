import { DEFAULT_KNOWLEDGE_BASE_ID } from '@/lib/orchestration/knowledge/document-manager';
import type { SeedUnit } from '@/prisma/runner';

const unit: SeedUnit = {
  name: '003-default-knowledge-base',
  async run({ prisma, logger }) {
    logger.info('📚 Seeding default knowledge base...');

    await prisma.aiKnowledgeBase.upsert({
      where: { id: DEFAULT_KNOWLEDGE_BASE_ID },
      update: {},
      create: {
        id: DEFAULT_KNOWLEDGE_BASE_ID,
        slug: 'default',
        name: 'Default',
        description: 'Default knowledge base for documents without an explicit corpus assignment',
        isDefault: true,
      },
    });

    logger.info('✅ Default knowledge base ready');
  },
};

export default unit;
