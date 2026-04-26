import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const allUsers = await prisma.user.findMany({
    include: { sites: true }
  });
  
  console.log("All users in database:");
  for (const user of allUsers) {
    console.log(`\nUser: ${user.email}`);
    console.log(`  Name: ${user.name}`);
    console.log(`  Role: ${user.role}`);
    console.log(`  Sites: ${user.sites.length}`);
    for (const site of user.sites) {
      const conversations = await prisma.conversation.count({ where: { siteId: site.id } });
      const knowledge = await prisma.knowledgeEntry.count({ where: { siteId: site.id } });
      const contacts = await prisma.contact.count({ where: { siteId: site.id } });
      console.log(`    Site: ${site.name} (ID: ${site.id})`);
      console.log(`      Conversations: ${conversations}`);
      console.log(`      Knowledge: ${knowledge}`);
      console.log(`      Contacts: ${contacts}`);
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
