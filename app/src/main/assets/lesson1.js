/*
 * Lesson content. To add a lesson, copy this file to lesson2.js, change the
 * data, and point index.html at it. Each step's done(sw) receives the
 * simulated switch and returns true once the step is complete.
 */
window.LESSON = {
  id: 1,
  title: 'Basic switch configuration',
  mission: 'Configure a switch named S1, protect privileged access, and save the configuration.',
  steps: [
    {
      task: 'Enter privileged EXEC mode',
      hint: 'You start at Switch>. One short command moves you to Switch#.',
      done: function (sw) { return sw.flags.priv; }
    },
    {
      task: 'Enter global configuration mode',
      hint: 'From Switch#, use configure terminal. The short form conf t also works.',
      done: function (sw) { return sw.flags.config; }
    },
    {
      task: 'Change the hostname to S1',
      hint: 'The command is hostname followed by the new name.',
      done: function (sw) { return sw.running.hostname === 'S1'; }
    },
    {
      task: 'Set the enable secret to class123',
      hint: 'Use enable secret followed by the password.',
      done: function (sw) { return sw.running.secret === 'class123'; }
    },
    {
      task: 'Return to privileged EXEC mode',
      hint: 'One command leaves any configuration mode and takes you straight to S1#.',
      done: function (sw) { return sw.flags.end; }
    },
    {
      task: 'Save the configuration to startup-config',
      hint: 'Use copy running-config startup-config, then press Enter at the filename prompt.',
      done: function (sw) {
        return !!sw.startup && sw.startup.hostname === 'S1' && sw.startup.secret === 'class123';
      }
    }
  ],
  quiz: [
    {
      q: 'Which command moves you from Switch> to Switch#?',
      mono: true,
      options: ['configure terminal', 'enable', 'hostname S1'],
      answer: 1,
      explain: 'enable moves you from user EXEC to privileged EXEC mode.'
    },
    {
      q: 'Which command changes the switch name to S1?',
      mono: true,
      options: ['enable secret S1', 'hostname S1', 'copy running-config startup-config'],
      answer: 1,
      explain: 'hostname S1 is entered in global configuration mode and changes the prompt.'
    },
    {
      q: 'Why do we use copy running-config startup-config?',
      mono: false,
      options: [
        'To rename the switch',
        'To save the configuration for the next restart',
        'To enable all switch ports'
      ],
      answer: 1,
      explain: 'The running-config lives in RAM and is lost on reload. The startup-config is kept in NVRAM.'
    }
  ]
};
