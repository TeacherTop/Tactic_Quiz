import type { NumericQuestion, QuizQuestion } from '../game/types'

export const NUMERIC_QUESTIONS: NumericQuestion[] = [
  {
    id: 'gagarin',
    prompt: 'В каком году Юрий Гагарин полетел в космос?',
    answer: 1961,
    unit: 'год',
  },
  {
    id: 'piano',
    prompt: 'Сколько клавиш у стандартного фортепиано?',
    answer: 88,
  },
  {
    id: 'leap',
    prompt: 'Сколько дней в високосном году?',
    answer: 366,
  },
  {
    id: 'eiffel',
    prompt: 'Какова высота Эйфелевой башни со шпилем, в метрах?',
    answer: 330,
    unit: 'м',
  },
  {
    id: 'spb',
    prompt: 'В каком году основан Санкт-Петербург?',
    answer: 1703,
    unit: 'год',
  },
  {
    id: 'bones',
    prompt: 'Сколько костей в скелете взрослого человека?',
    answer: 206,
  },
  {
    id: 'ussr',
    prompt: 'В каком году распался СССР?',
    answer: 1991,
    unit: 'год',
  },
  {
    id: 'football',
    prompt: 'Сколько футболистов одной команды одновременно на поле?',
    answer: 11,
  },
  {
    id: 'periodic-table',
    prompt: 'Сколько химических элементов официально входит в современную периодическую таблицу?',
    answer: 118,
  },
  {
    id: 'chess-board',
    prompt: 'Сколько клеток на стандартной шахматной доске?',
    answer: 64,
  },
  {
    id: 'earth-radius',
    prompt: 'Каков средний радиус Земли в километрах?',
    answer: 6371,
    unit: 'км',
  },
  {
    id: 'olympic-rings',
    prompt: 'Сколько колец изображено на олимпийском символе?',
    answer: 5,
  },
]

export const QUIZ_QUESTIONS: QuizQuestion[] = [
  {
    id: 'nile',
    prompt: 'Какая река считается самой длинной в мире?',
    options: ['Амазонка', 'Нил', 'Янцзы', 'Миссисипи'],
    correctIndex: 1,
  },
  {
    id: 'oxygen',
    prompt: 'Какой химический элемент обозначается как O?',
    options: ['Осмий', 'Олово', 'Кислород', 'Золото'],
    correctIndex: 2,
  },
  {
    id: 'pushkin',
    prompt: 'Кто написал роман в стихах «Евгений Онегин»?',
    options: ['Лермонтов', 'Пушкин', 'Гоголь', 'Тургенев'],
    correctIndex: 1,
  },
  {
    id: 'planet',
    prompt: 'Какая планета Солнечной системы самая большая?',
    options: ['Сатурн', 'Нептун', 'Юпитер', 'Уран'],
    correctIndex: 2,
  },
  {
    id: 'photosynth',
    prompt: 'Что растения выделяют при фотосинтезе?',
    options: ['Азот', 'Углекислый газ', 'Кислород', 'Метан'],
    correctIndex: 2,
  },
  {
    id: 'baikal',
    prompt: 'Самое глубокое озеро на Земле — это…',
    options: ['Каспийское море', 'Байкал', 'Танганьика', 'Виктория'],
    correctIndex: 1,
  },
  {
    id: 'newton',
    prompt: 'Кто сформулировал закон всемирного тяготения?',
    options: ['Эйнштейн', 'Галилей', 'Ньютон', 'Кеплер'],
    correctIndex: 2,
  },
  {
    id: 'capital',
    prompt: 'Столица Австралии — это…',
    options: ['Сидней', 'Мельбурн', 'Канберра', 'Перт'],
    correctIndex: 2,
  },
  {
    id: 'mendeleev',
    prompt: 'Кто составил периодическую таблицу элементов?',
    options: ['Менделеев', 'Бойль', 'Лавуазье', 'Кюри'],
    correctIndex: 0,
  },
  {
    id: 'speed',
    prompt: 'Какая скорость света в вакууме, примерно?',
    options: ['300 км/с', '300 000 км/с', '3 000 км/с', '30 000 км/с'],
    correctIndex: 1,
  },
  {
    id: 'war1812',
    prompt: 'В каком веке была Отечественная война 1812 года?',
    options: ['XVII', 'XVIII', 'XIX', 'XX'],
    correctIndex: 2,
  },
  {
    id: 'dna',
    prompt: 'Из чего в основном состоит молекула ДНК?',
    options: ['Белки', 'Нуклеотиды', 'Липиды', 'Сахара только'],
    correctIndex: 1,
  },
]
