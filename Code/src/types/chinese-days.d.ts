declare module "chinese-days/dist/index.min.js" {
  const chineseDays: {
    isWorkday: (date: string | Date) => boolean;
  };

  export default chineseDays;
}
