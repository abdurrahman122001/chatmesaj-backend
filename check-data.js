import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const users = await prisma.user.findMany({ include: { sites: true } });
  console.log(`Users: ${users.length}`);
  
  for (const user of users) {
    console.log(`- ${user.email} (${user.sites.length} sites)`);
    for (const site of user.sites) {
      const conversations = await prisma.conversation.count({ where: { siteId: site.id } });
      const knowledge = await prisma.knowledgeEntry.count({ where: { siteId: site.id } });
      const contacts = await prisma.contact.count({ where: { siteId: site.id } });
      console.log(`  Site: ${site.name} (ID: ${site.id})`);
      console.log(`    Conversations: ${conversations}`);
      console.log(`    Knowledge entries: ${knowledge}`);
      console.log(`    Contacts: ${contacts}`);
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
