// Backend i18n: widget və bot mesajları üçün 4 dildə (AZ / EN / TR / RU).
// İstifadə: import { t } from '../lib/i18n.js';  t('botNoAnswer', siteLanguage)

const MESSAGES = {
  defaultTitle:            { AZ: "Dəstək", EN: "Support", TR: "Destek", RU: "Поддержка" },
  defaultSubtitle:         { AZ: "Sizə necə kömək edə bilərik?", EN: "How can we help?", TR: "Size nasıl yardımcı olabiliriz?", RU: "Чем мы можем помочь?" },
  greeting:                { AZ: "Salam! Sizə necə kömək edə bilərəm?", EN: "Hello! How can I help you today?", TR: "Merhaba! Size nasıl yardımcı olabilirim?", RU: "Здравствуйте! Чем я могу помочь?" },
  botNoAnswerWithContact:  { AZ: "Cavabı tapa bilmədim. Operatorumuzun sizə qayıtması üçün zəhmət olmasa əlaqə məlumatlarınızı daxil edin.", EN: "I couldn't find the answer. Please enter your contact information so our operator can get back to you.", TR: "Yanıtı bulamadım. Operatörümüzün size dönebilmesi için lütfen iletişim bilgilerinizi girin.", RU: "Не удалось найти ответ. Пожалуйста, введите контактные данные, чтобы оператор мог связаться с вами." },
  botNoAnswer:             { AZ: "Cavabı tapa bilmədim. Operatorumuz sizə ən qısa zamanda qayıdacaq.", EN: "I couldn't find the answer. Our operator will get back to you as soon as possible.", TR: "Yanıtı bulamadım. Operatörümüz en kısa sürede size dönecek.", RU: "Не удалось найти ответ. Оператор свяжется с вами в ближайшее время." },
  contactSaved:            { AZ: "📇 Əlaqə məlumatları qeyd olundu:", EN: "📇 Contact information saved:", TR: "📇 İletişim bilgileri kaydedildi:", RU: "📇 Контактные данные сохранены:" },
  enterContactForOperator: { AZ: "Operatorumuzla əlaqə qurmaq üçün zəhmət olmasa ad, email və telefon nömrənizi daxil edin.", EN: "Please enter your name, email and phone number to contact our operator.", TR: "Operatörümüzle iletişime geçmek için lütfen ad, e-posta ve telefon numaranızı girin.", RU: "Пожалуйста, введите имя, email и номер телефона, чтобы связаться с оператором." },
  afterInfoOperator:       { AZ: "Məlumatlarınızı daxil etdikdən sonra operatorumuza yaza biləcəksiniz.", EN: "You will be able to write to our operator after entering your information.", TR: "Bilgilerinizi girdikten sonra operatörümüze yazabileceksiniz.", RU: "После ввода ваших данных вы сможете написать оператору." },
  operatorConnected:       { AZ: "Operator bağlandı. Sizə ən qısa zamanda qayıdacaqlar.", EN: "Operator connected. They will get back to you as soon as possible.", TR: "Operatör bağlandı. En kısa sürede size dönecekler.", RU: "Оператор подключён. Он свяжется с вами в ближайшее время." },
  ticketCreated:           { AZ: "Bilet yaradıldı:", EN: "Ticket created:", TR: "Bilet oluşturuldu:", RU: "Тикет создан:" },
  chatClosed:              { AZ: "Dəstək bu çatı bağladı. Davam etmək üçün yeni chat başladın.", EN: "Support closed this chat. Start a new chat to continue.", TR: "Destek bu sohbeti kapattı. Devam etmek için yeni bir sohbet başlatın.", RU: "Поддержка закрыла этот чат. Начните новый чат, чтобы продолжить." },
  labelName:               { AZ: "Ad", EN: "Name", TR: "Ad", RU: "Имя" },
  labelPhone:              { AZ: "Telefon", EN: "Phone", TR: "Telefon", RU: "Телефон" },
  ticketCreatedPrefix:     { AZ: "🎫 Bilet yaradıldı", EN: "🎫 Ticket created", TR: "🎫 Bilet oluşturuldu", RU: "🎫 Тикет создан" },
  chatEndedByUser:         { AZ: "Söhbət istifadəçi tərəfindən bağlandı.", EN: "Chat ended by user.", TR: "Sohbet kullanıcı tarafından sonlandırıldı.", RU: "Чат завершён пользователем." },
};

const SUPPORTED = ["AZ", "EN", "TR", "RU"];
const DEFAULT = "AZ";

export function t(key, lang) {
  const entry = MESSAGES[key];
  if (!entry) return key;
  const l = SUPPORTED.includes(lang) ? lang : DEFAULT;
  return entry[l] ?? entry.EN ?? entry.AZ ?? key;
}

export default MESSAGES;
