import type { TableCol } from './xlsx.ts';

// Columns of the favourites spreadsheet. The monitor (src/table.ts) fills the rows in this order; the worker
// puts its own columns (rank, who liked) in front.
export const TABLE_COLS: TableCol[] = [
  { h: 'Баллы из 100', w: 8, f: 'int' }, { h: 'Из чего баллы', w: 44, f: 'wrap' },
  { h: 'Район', w: 22 }, { h: 'Муниципалитет', w: 13 }, { h: 'Адрес', w: 22 },
  { h: 'Цена', w: 11, f: 'eur' }, { h: 'История цены', w: 18 },
  { h: 'Налоги и сборы при покупке', w: 12, f: 'eur' }, { h: 'Ипотека, €/мес', w: 10, f: 'eur' }, { h: 'Кондоминиум, €/мес', w: 10, f: 'eur' }, { h: '€/м²', w: 8, f: 'eur' },
  { h: '€/м² к району', w: 10, f: 'pct' }, { h: 'Сделки INE, €/м²', w: 10, f: 'eur' }, { h: '€/м² к сделкам INE', w: 10, f: 'pct' }, { h: 'Площадь, м²', w: 8, f: 'int' }, { h: 'Спальни', w: 7, f: 'int' },
  { h: 'Санузлы', w: 7, f: 'int' }, { h: 'Гараж', w: 6 }, { h: 'Этаж', w: 6 }, { h: 'Лифт', w: 6 }, { h: 'Состояние', w: 13 },
  { h: 'Год постройки', w: 8, f: 'int' }, { h: 'Энергокласс', w: 8 }, { h: 'Удобства (из текста)', w: 30, f: 'wrap' },
  { h: 'До школы, мин', w: 8, f: 'int' }, { h: 'Рядом (OSM, по прямой)', w: 40, f: 'wrap' }, { h: 'Подтопление (APA)', w: 22, f: 'wrap' }, { h: 'Самолёты (OpenSky)', w: 30, f: 'wrap' }, { h: 'Адрес точный?', w: 9 }, { h: 'В продаже, дней', w: 9, f: 'int' },
  { h: 'Подходит?', w: 26, f: 'wrap' }, { h: 'Плюс / минус', w: 40, f: 'wrap' },
  { h: 'Объявление', w: 12, f: 'link' }, { h: 'Маршрут', w: 10, f: 'link' }, { h: 'Где ещё опубликовано', w: 30, f: 'wrap' },
  { h: 'Статус', w: 14 }, { h: 'Просмотр (дата)', w: 14 }, { h: 'Впечатление', w: 24, f: 'wrap' }, { h: 'Заметки', w: 30, f: 'wrap' },
];
